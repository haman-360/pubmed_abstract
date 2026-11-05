// Shared D1 operations. Entrypoints must authenticate before calling runLedgerAction.
import {exportBackup} from './backup-data.mjs';
import {metadataNames,requireThat,hash,records,validKey,projectionStatements} from './metadata.mjs';
import {operationRequest,statuses} from './operations.mjs';
import {FORMAT,begin,upload,buildPage,finish,readChunk,chunkedDetail,buildIssue} from './chunked.mjs';
import {startBackup,backupPage} from './backup-pages.mjs';
import {browseIssues} from './browse.mjs';

export async function backfillLists(db) {
  const {results}=await db.prepare(`SELECT g.id,g.tables_json FROM generations g WHERE EXISTS(
    SELECT 1 FROM issues i WHERE i.generation=g.id AND NOT EXISTS(
      SELECT 1 FROM issue_lists l WHERE l.generation=i.generation AND l.issue_key=i.issue_key))`).all();
  for(const g of results){
    if(JSON.parse(g.tables_json).format===FORMAT){
      // Interrupted uploads resume through /sync/build; startup must not project incomplete sources.
      if(!await db.prepare('SELECT generation FROM generation_ready WHERE generation=?').bind(g.id).first())continue;
      const keys=(await db.prepare('SELECT issue_key FROM issues WHERE generation=?').bind(g.id).all()).results;
      for(const row of keys)await buildIssue(db,g.id,row.issue_key);
    }
    else await db.batch(projectionStatements(db,g.id,JSON.parse(g.tables_json)));
  }
}
async function issuePapers(db,r) {
  validKey(r.issue_key);
  const query=String(r.query??'').trim().toLowerCase(), offset=r.offset??0;
  requireThat(query.length<=300&&(!r.status||statuses.has(r.status))&&Number.isSafeInteger(offset)&&offset>=0,'invalid_filter');
  const result=await db.prepare(`WITH selected AS (
    SELECT v.revision,v.item_json,l.items_json FROM issue_states v JOIN issue_lists l
    ON l.generation=v.revision AND l.issue_key=v.issue_key WHERE v.issue_key=?),
    filtered AS (SELECT CAST(p.key AS INTEGER) position,json_extract(p.value,'$.pmid') pmid,
      json_extract(p.value,'$.title') title,json_extract(p.value,'$.score') score,
      COALESCE(c.version,0) version,COALESCE(c.status,'unreviewed') status,COALESCE(c.note,'') note,
      COALESCE(c.status_updated_at,'') status_updated_at,COALESCE(c.updated_at,'') updated_at
      FROM selected s,json_each(s.items_json) p LEFT JOIN review_current c ON c.pmid=json_extract(p.value,'$.pmid')
      WHERE (?='' OR instr(json_extract(p.value,'$.pmid'),?)>0 OR instr(json_extract(p.value,'$.search_title'),?)>0)
      AND (?='' OR COALESCE(c.status,'unreviewed')=?)),
    totals AS (SELECT count(*) total FROM filtered),
    paging AS (SELECT total,CASE WHEN ?<total THEN ? ELSE max(0,CAST((total-1)/50 AS INTEGER)*50) END offset FROM totals)
    SELECT s.revision,s.item_json,p.total,p.offset,(SELECT json_group_array(json(item)) FROM (
      SELECT json_object('pmid',pmid,'title',title,'score',json(score),'review',json_object(
        'version',version,'status',status,'note',note,'status_updated_at',status_updated_at,'updated_at',updated_at)) item
      FROM filtered ORDER BY position LIMIT 50 OFFSET (SELECT offset FROM paging))) items
    FROM selected s,paging p`).bind(r.issue_key,query,query,query,r.status||'',r.status||'',offset,offset).first();
  requireThat(result,'issue_missing',404);
  const {scores_available,...issue}=JSON.parse(result.item_json);
  return {items:JSON.parse(result.items),total:result.total,offset:result.offset,page_size:50,issue,scores_available,revision:result.revision};
}
async function detail(db,r) {
  requireThat(/^[1-9][0-9]{0,8}$/.test(r.pmid??''),'invalid_pmid');
  if(r.issue_key)validKey(r.issue_key);
  const storage=await db.prepare("SELECT json_extract(g.tables_json,'$.format') format FROM generations g JOIN settings s ON s.generation=g.id").first();
  if(storage?.format===FORMAT)return chunkedDetail(db,r);
  const row=await db.prepare(`WITH g AS (SELECT g.id,g.tables_json FROM generations g JOIN settings s ON s.generation=g.id),
    appearances AS (SELECT a.value FROM g,json_each(g.tables_json,'$.Appearances') a
      WHERE a.key>0 AND json_extract(a.value,'$[1]')=? AND (?='' OR
        json_array(json_extract(a.value,'$[2]'),json_extract(a.value,'$[3]'))=?))
    SELECT g.id revision,(SELECT json_group_array(json_object('row',json(a.value),'body',
      (SELECT group_concat(body,'') FROM (SELECT json_extract(t.value,'$[2]') body
        FROM json_each(g.tables_json,'$.Texts') t WHERE t.key>0
        AND json_extract(t.value,'$[0]')=json_extract(a.value,'$[9]') ORDER BY CAST(json_extract(t.value,'$[1]') AS INTEGER)))))
      FROM appearances a) items FROM g`).bind(r.pmid,r.issue_key||'',r.issue_key||'').first();
  requireThat(row,'metadata_not_seeded',409);
  const names=['snapshot_id','pmid','issue_id','topic','delivered_date','title_at_delivery','selection','current_doc_url','source','text_id'];
  const appearances=JSON.parse(row.items).map(a=>({...Object.fromEntries(names.map((n,i)=>[n,a.row[i]])),text:JSON.parse(a.body)}))
    .sort((a,b)=>b.delivered_date.localeCompare(a.delivered_date)||a.issue_id.localeCompare(b.issue_id));
  requireThat(appearances.length,'paper_missing',404);
  return {revision:row.revision,appearances};
}
async function stage(db, body) {
  requireThat(body.synthetic === true && /^[a-f0-9]{64}$/.test(body.generation ?? ''), 'synthetic_fixture_required');
  const t = body.tables;
  requireThat(t && Object.keys(t).length === metadataNames.length && metadataNames.every(n => Array.isArray(t[n]) && t[n].length > 0), 'metadata_tables_only');
  // This first stage only accepts the deterministic fixture schema, not production migration files.
  const headers = {Papers: ['pmid','title'], Appearances: ['snapshot_id','pmid','issue_id','topic'],
    Texts: ['text_id','part','body'], Issues: ['issue_key','issue_id','topic','delivered_date','pmids','content_version'],
    TextRows: ['text_id','first_row','row_count'], IssueCandidates: ['issue_key','pmid','snapshot_id','position','title'],
    IssueCandidateRows: ['issue_key','first_row','row_count']};
  for (const n of metadataNames) requireThat(headers[n].every((v, i) => t[n][0][i] === v) && t[n].every(row => Array.isArray(row) && row.length === t[n][0].length && row.every(v => typeof v === 'string')), 'invalid_metadata_schema');
  for (const i of records(t.Issues)) validKey(i.issue_key);
  const digest = await hash(t);
  const g = body.generation;
  const tablesJson=JSON.stringify(t);
  requireThat(new TextEncoder().encode(tablesJson).byteLength<=1900000,'metadata_requires_chunked_storage',413);
  await db.batch([
    db.prepare('INSERT INTO generations VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(g, digest, tablesJson),
    db.prepare('INSERT INTO publish_guard SELECT CASE WHEN payload_hash=? THEN 1 ELSE 0 END FROM generations WHERE id=?').bind(digest, g),
    db.prepare(`INSERT OR IGNORE INTO papers SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)`).bind(g, JSON.stringify(t.Papers.slice(1))),
    db.prepare(`INSERT OR IGNORE INTO issues SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[5]') FROM json_each(?)`).bind(g, JSON.stringify(t.Issues.slice(1))),
    db.prepare(`INSERT OR IGNORE INTO members SELECT ?,json_extract(i.value,'$[0]'),p.value
      FROM json_each(?) i JOIN json_each(json_extract(i.value,'$[4]')) p`).bind(g, JSON.stringify(t.Issues.slice(1))),
    ...projectionStatements(db,g,t),
    db.prepare('DELETE FROM publish_guard')
  ]);
  return {staged: true, generation: g};
}
async function publish(db, body) {
  requireThat(typeof body.generation === 'string' && (body.expected_revision === null || typeof body.expected_revision === 'string'), 'invalid_publish');
  await db.batch([
    db.prepare(`INSERT INTO publish_guard VALUES((SELECT CASE WHEN (generation IS ? OR generation=?) AND EXISTS(
      SELECT 1 FROM generations g WHERE id=? AND (json_extract(g.tables_json,'$.format') IS NOT 'LOCAL_D1_CHUNKS_V2'
      OR EXISTS(SELECT 1 FROM generation_ready r WHERE r.generation=g.id AND r.manifest_hash=g.payload_hash))) THEN 1 ELSE 0 END FROM settings WHERE id=1))`).bind(body.expected_revision, body.generation, body.generation),
    db.prepare('UPDATE settings SET generation=? WHERE id=1').bind(body.generation),
    db.prepare('DELETE FROM publish_guard')
  ]);
  return {published: true, revision: body.generation};
}
async function save(db, body, kind) {
  const r = operationRequest(body, kind);
  const digest = await hash(r);
  const statements = [db.prepare('INSERT INTO operations VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
    .bind(r.operation_id, digest, JSON.stringify(r), new Date().toISOString())];
  const result = await db.batch(statements);
  const row=await db.prepare(`SELECT generation revision,
    (SELECT item_json FROM issue_states WHERE issue_key=?) issue,
    (SELECT json_group_array(json_object('pmid',q.value,'review',json_object('version',COALESCE(c.version,0),
      'status',COALESCE(c.status,'unreviewed'),'note',COALESCE(c.note,''),
      'status_updated_at',COALESCE(c.status_updated_at,''),'updated_at',COALESCE(c.updated_at,''))))
      FROM json_each(?) q LEFT JOIN review_current c ON c.pmid=q.value) reviews FROM settings WHERE id=1`)
    .bind(r.issue_key||'',JSON.stringify(r.changes.map(c=>c.pmid))).first();
  const current=row.issue?JSON.parse(row.issue):null;
  if(current)delete current.scores_available;
  return {saved:true,replayed:result[0].meta.changes===0,revision:row.revision,
    completion_recorded:kind==='complete'||(kind==='issue'&&r.status==='completed'),
    completed:(kind==='complete'||r.status==='completed')&&current?.status==='completed',
    reviews:JSON.parse(row.reviews),issue:current};
}

export async function runLedgerAction(db,path,body,{now=new Date()}={}) {
  let value;
  if(path==='/sync/status') {
    const row=await db.prepare(`SELECT s.generation revision,g.payload_hash,g.tables_json
      FROM settings s LEFT JOIN generations g ON g.id=s.generation WHERE s.id=1`).first();
    const stored=row.tables_json?JSON.parse(row.tables_json):null;
    value={revision:row.revision,payload_hash:row.payload_hash,tables:stored?.format===FORMAT?null:stored,
      ...(stored?.format===FORMAT?{manifest:stored}:{})};
  }
  else if(path==='/sync/begin')value=await begin(db,body);
  else if(path==='/sync/chunk')value=await upload(db,body);
  else if(path==='/sync/build')value=await buildPage(db,body);
  else if(path==='/sync/finish')value=await finish(db,body);
  else if(path==='/sync/read')value=await readChunk(db,body);
  else if (path === '/sync/stage') value = await stage(db, body);
  else if (path === '/sync/publish') value = await publish(db, body);
  else if (path === '/api/saveReviews') value = await save(db, body, 'reviews');
  else if (path === '/api/saveAndCompleteIssue') value = await save(db, body, 'complete');
  else if (path === '/api/saveIssueReview') value = await save(db, body, 'issue');
  else if(path==='/api/backup') value=await exportBackup(db);
  else if(path==='/api/backupStart')value=await startBackup(db);
  else if(path==='/api/backupPage')value=await backupPage(db,body);
  else if(path==='/api/listIssues') value=await browseIssues(db,body,now);
  else if(path==='/api/listIssuePapers') value=await issuePapers(db,body);
  else if(path==='/api/getPaperDetail') value=await detail(db,body);
  else throw Object.assign(new Error('unknown_endpoint'),{status:404});
  return value;
}
