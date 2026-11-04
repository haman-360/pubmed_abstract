// Local experiment only. No production authentication or external service calls.
import {exportBackup} from './backup-data.mjs';
import {profiledDatabase,newProfile} from './profile.mjs';
const statuses = new Set(['unreviewed', 'reviewed_no_fulltext', 'want_fulltext', 'fulltext_obtained', 'read']);
const metadataNames = ['Papers', 'Appearances', 'Texts', 'Issues', 'TextRows', 'IssueCandidates', 'IssueCandidateRows'];
const defaultReview = () => ({status: 'unreviewed', version: 0, note: '', status_updated_at: '', updated_at: ''});
function requireThat(ok, code, status = 400) {
  if (!ok) throw Object.assign(new Error(code), {status});
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function records(rows) {
  return rows.slice(1).map(row => Object.fromEntries(rows[0].map((key, i) => [key, row[i] ?? ''])));
}
function validKey(key) {
  let parsed;
  try { parsed = JSON.parse(key); } catch { /* validated below */ }
  requireThat(Array.isArray(parsed) && parsed.length === 2 && parsed.every(x => typeof x === 'string' && x.length > 0), 'invalid_issue_key');
  requireThat(JSON.stringify(parsed) === key, 'noncanonical_issue_key');
}
function operationRequest(body, kind) {
  const r = {kind, operation_id: body.operation_id, revision: body.revision, changes: body.changes ?? []};
  requireThat(/^[A-Za-z0-9-]{16,80}$/.test(r.operation_id ?? ''), 'invalid_operation_id');
  requireThat(typeof r.revision === 'string' && /^[a-f0-9]{64}$/.test(r.revision), 'invalid_revision');
  requireThat(Array.isArray(r.changes) && r.changes.length <= 100 && (kind !== 'reviews' || r.changes.length > 0), 'invalid_change_count');
  const ids = new Set();
  r.changes = r.changes.map(c => {
    requireThat(c && typeof c.pmid === 'string' && /^[1-9][0-9]{0,8}$/.test(c.pmid) && !ids.has(c.pmid), 'invalid_or_duplicate_pmid');
    ids.add(c.pmid);
    requireThat(statuses.has(c.status) && typeof c.note === 'string' && c.note.length <= 2000 && Number.isSafeInteger(c.expected_version) && c.expected_version >= 0, 'invalid_review');
    return {pmid: c.pmid, status: c.status, note: c.note, expected_version: c.expected_version};
  });
  if (body.issue_key !== undefined || kind !== 'reviews') {
    validKey(body.issue_key);
    r.issue_key = body.issue_key;
  }
  if (kind !== 'reviews') {
    requireThat(Number.isSafeInteger(body.expected_version) && body.expected_version >= 0 && typeof body.content_version === 'string', 'invalid_issue_version');
    r.expected_version = body.expected_version;
    r.content_version = body.content_version;
    r.status = kind === 'complete' ? 'completed' : body.status;
    requireThat(['unreviewed', 'in_progress', 'completed'].includes(r.status), 'invalid_issue_status');
  }
  if (kind === 'issue') requireThat(r.changes.length === 0, 'issue_changes_forbidden');
  if (kind === 'complete' && r.changes.length) {
    requireThat(/^[A-Za-z0-9-]{16,80}$/.test(body.review_operation_id ?? '') && body.review_operation_id !== r.operation_id, 'invalid_review_operation_id');
    r.review_operation_id = body.review_operation_id;
  } else requireThat(!body.review_operation_id, 'unexpected_review_operation_id');
  return r;
}

// Body-free projections are built once at sync time, including Unicode case folding.
function listProjection(t, raw) {
  const apps = records(t.Appearances).filter(a => JSON.stringify([a.issue_id,a.topic]) === raw.issue_key);
  const ids = JSON.parse(raw.pmids);
  const candidates = records(t.IssueCandidates).filter(c => c.issue_key === raw.issue_key);
  const scored = candidates.length === ids.length && new Set(candidates.map(c => c.pmid)).size === ids.length && candidates.every(c => ids.includes(c.pmid));
  const rows = scored ? candidates.sort((a,b) => Number(a.position)-Number(b.position))
    : records(t.Papers).filter(p => ids.includes(p.pmid)).sort((a,b) => Number(a.pmid)-Number(b.pmid));
  const items = rows.map(p => {
    const title = scored ? p.title : apps.find(a => a.pmid === p.pmid)?.title_at_delivery || p.title;
    return {pmid:p.pmid,title,search_title:title.toLowerCase(),score:scored ? {total:p.total_score,usefulness:p.usefulness,memo:p.ai_memo} : null};
  });
  return {info:{issue_key:raw.issue_key,issue_id:raw.issue_id,topic:raw.topic,delivered_date:raw.delivered_date,
    total:ids.length,content_version:raw.content_version,recovered:/^(local:|current_copy:)/.test(raw.issue_id),scores_available:scored},items};
}
function projectionStatements(db,g,t) {
  return records(t.Issues).map(raw => {
    const {info,items}=listProjection(t,raw);
    return db.prepare('INSERT OR IGNORE INTO issue_lists VALUES(?,?,?,?)').bind(g,raw.issue_key,JSON.stringify(info),JSON.stringify(items));
  });
}
export async function backfillLists(db) {
  const {results}=await db.prepare(`SELECT g.id,g.tables_json FROM generations g WHERE EXISTS(
    SELECT 1 FROM issues i WHERE i.generation=g.id AND NOT EXISTS(
      SELECT 1 FROM issue_lists l WHERE l.generation=i.generation AND l.issue_key=i.issue_key))`).all();
  for(const g of results) await db.batch(projectionStatements(db,g.id,JSON.parse(g.tables_json)));
}
async function listIssues(db,r) {
  const {results}=await db.prepare(`SELECT revision,item_json FROM issue_states ORDER BY
    json_extract(item_json,'$.delivered_date') DESC,json_extract(item_json,'$.issue_id') DESC,
    json_extract(item_json,'$.topic')`).all();
  requireThat(results.length,'metadata_not_seeded',409);
  return {...page(results.map(row => {const {scores_available,...i}=JSON.parse(row.item_json);return i;}),r.offset,20),revision:results[0].revision};
}
function page(items,offset,size) {
  offset ??= 0;
  requireThat(Number.isSafeInteger(offset)&&offset>=0,'invalid_offset');
  if(offset>=items.length)offset=Math.max(0,Math.floor((items.length-1)/size)*size);
  return {items:items.slice(offset,offset+size),total:items.length,offset,page_size:size};
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
      SELECT 1 FROM generations WHERE id=?) THEN 1 ELSE 0 END FROM settings WHERE id=1))`).bind(body.expected_revision, body.generation, body.generation),
    db.prepare('UPDATE settings SET generation=? WHERE id=1').bind(body.generation),
    db.prepare('DELETE FROM publish_guard')
  ]);
  return {published: true, revision: body.generation};
}
async function save(db, body, kind, fault) {
  const r = operationRequest(body, kind);
  const digest = await hash(r);
  const statements = [db.prepare('INSERT INTO operations VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
    .bind(r.operation_id, digest, JSON.stringify(r), new Date().toISOString())];
  if (fault === 'rollback') statements.push(db.prepare('INSERT INTO publish_guard VALUES(0)'));
  const result = await db.batch(statements);
  if (fault === 'drop-response') throw Object.assign(new Error('local_response_lost_retry_same_request'), {status: 503});
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

export default {
  async fetch(request, env) {
    const started=performance.now();let profile=null;
    const url = new URL(request.url);
    const headers = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'};
    try {
      requireThat(env.LOCAL_PROTOTYPE === '1' && ['127.0.0.1', 'localhost'].includes(url.hostname), 'local_only', 403);
      if (request.method === 'GET' && url.pathname === '/') return new Response(env.LOCAL_HTML, {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}});
      requireThat(request.method === 'POST', 'post_required', 405);
      const origin = request.headers.get('Origin');
      requireThat(!origin || origin === url.origin, 'origin_denied', 403);
      requireThat(request.headers.get('Content-Type')?.split(';')[0] === 'application/json', 'json_required', 415);
      const token = request.headers.get('Authorization');
      const syncing = url.pathname.startsWith('/sync/');
      requireThat(token === (syncing ? 'Bearer local-synthetic-sync' : 'Bearer local-synthetic-owner'), 'local_identity_denied', 403);
      const text = await request.text();
      requireThat(new TextEncoder().encode(text).byteLength <= 2000000, 'request_too_large', 413);
      const body = JSON.parse(text);
      profile=request.headers.get('X-Local-Profile')==='1'?newProfile():null;
      const db=profile?profiledDatabase(env.DB,profile):env.DB;
      let value;
      if(url.pathname==='/sync/status') {
        const row=await db.prepare(`SELECT s.generation revision,g.payload_hash,g.tables_json
          FROM settings s LEFT JOIN generations g ON g.id=s.generation WHERE s.id=1`).first();
        value={revision:row.revision,payload_hash:row.payload_hash,tables:row.tables_json?JSON.parse(row.tables_json):null};
      }
      else if (url.pathname === '/sync/stage') value = await stage(db, body);
      else if (url.pathname === '/sync/publish') value = await publish(db, body);
      else if (url.pathname === '/api/saveReviews') value = await save(db, body, 'reviews', request.headers.get('X-Local-Fault'));
      else if (url.pathname === '/api/saveAndCompleteIssue') value = await save(db, body, 'complete', request.headers.get('X-Local-Fault'));
      else if (url.pathname === '/api/saveIssueReview') value = await save(db, body, 'issue', request.headers.get('X-Local-Fault'));
      else if(url.pathname==='/api/backup') value=await exportBackup(db);
      else if(url.pathname==='/api/listIssues') value=await listIssues(db,body);
      else if(url.pathname==='/api/listIssuePapers') value=await issuePapers(db,body);
      else if(url.pathname==='/api/getPaperDetail') value=await detail(db,body);
      else throw Object.assign(new Error('unknown_endpoint'),{status:404});
      if(profile)profile.worker_wall_ms=performance.now()-started;
      return new Response(JSON.stringify({value,...(profile?{profile}:{})}), {headers});
    } catch (e) {
      const status = e.status ?? (/operation_id_reused|UNIQUE|conflict|remaining|CHECK|missing/.test(e.message) ? 409 : 400);
      return new Response(JSON.stringify({error: e.status ? e.message : status === 409 ? 'conflict_or_invalid_atomic_operation' : 'invalid_request_or_database_failure'}), {status, headers});
    }
  }
};
