import {browseWindow} from './browse.mjs';
import {metadataNames,requireThat,hash,records,validKey,listProjection} from './metadata.mjs';
export const FORMAT='LOCAL_D1_CHUNKS_V2';
export const CHUNK_BYTES=196608;
export const ROW_BYTES=180000;
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).byteLength;
export const headers={
  Papers:['pmid','title','journal','publication_date','pubmed_url','doi','topics','first_seen','last_seen','sources'],
  Appearances:['snapshot_id','pmid','issue_id','topic','delivered_date','title_at_delivery','selection','current_doc_url','source','text_id'],
  Texts:['text_id','part','body'],Issues:['issue_key','issue_id','topic','delivered_date','pmids','content_version'],
  TextRows:['text_id','first_row','row_count'],
  IssueCandidates:['issue_key','pmid','snapshot_id','position','title','total_score','usefulness','ai_memo','text_id'],
  IssueCandidateRows:['issue_key','first_row','row_count']
};
export async function manifestFor(tables){
  const manifest={format:FORMAT,tables:{}},chunks=[];
  for(const name of metadataNames){
    requireThat(JSON.stringify(tables[name]?.[0])===JSON.stringify(headers[name]),'invalid_metadata_header');
    const spec={header:headers[name],count:tables[name].length-1,chunks:[]};manifest.tables[name]=spec;
    let rows=[],size=2,offset=0;
    async function flush(){if(!rows.length)return;const descriptor={index:spec.chunks.length,offset,count:rows.length,bytes:bytes(rows),sha256:await hash(rows)};
      spec.chunks.push(descriptor);chunks.push({table_name:name,index:descriptor.index,rows});offset+=rows.length;rows=[];size=2;}
    for(const row of tables[name].slice(1)){const length=bytes(row);requireThat(length<=ROW_BYTES,'metadata_row_too_large',413);
      if(rows.length&&size+length+1>CHUNK_BYTES)await flush();rows.push(row);size+=length+(rows.length>1?1:0);}
    await flush();
  }
  return {manifest,chunks};
}
export function validateManifest(m,{historical=false}={}){
  requireThat(m?.format===FORMAT&&m.tables&&Object.keys(m.tables).length===metadataNames.length&&bytes(m)<=CHUNK_BYTES,'invalid_manifest');
  requireThat(m.data_source===undefined||['real-copy','recent-copy'].includes(m.data_source),'invalid_data_source');
  if(['real-copy','recent-copy'].includes(m.data_source)){
    const w=m.trial_window,recent=browseWindow();
    requireThat(w&&/^\d{4}-\d{2}-\d{2}$/.test(w.from)&&/^\d{4}-\d{2}-\d{2}$/.test(w.through)&&w.from<=w.through&&(historical||(w.from>=recent.from&&w.through<=recent.through)),'recent_trial_window_required');
    requireThat(m.tables.Papers.count>0&&m.tables.Papers.count<=(m.data_source==='recent-copy'?5000:50)&&m.tables.Issues.count>0&&m.tables.Issues.count<=(m.data_source==='recent-copy'?500:3),'small_trial_required');
  }
  for(const name of metadataNames){const spec=m.tables[name];
    requireThat(spec&&JSON.stringify(spec.header)===JSON.stringify(headers[name])&&Number.isSafeInteger(spec.count)&&spec.count>=0&&Array.isArray(spec.chunks),'invalid_manifest_table');
    let offset=0;
    for(const [index,c]of spec.chunks.entries()){
      requireThat(c.index===index&&c.offset===offset&&Number.isSafeInteger(c.count)&&c.count>0&&Number.isSafeInteger(c.bytes)&&c.bytes>0&&c.bytes<=CHUNK_BYTES&&/^[a-f0-9]{64}$/.test(c.sha256),'invalid_chunk_descriptor');offset+=c.count;
    }
    requireThat(offset===spec.count,'invalid_manifest_count');
  }
}
export async function begin(db,body){
  requireThat(/^[a-f0-9]{64}$/.test(body.generation??'')&&((body.synthetic===true&&body.real_copy===undefined&&body.recent_copy===undefined&&body.manifest?.data_source===undefined)||(body.real_copy===true&&body.synthetic===undefined&&body.recent_copy===undefined&&body.manifest?.data_source==='real-copy')||(body.recent_copy===true&&body.synthetic===undefined&&body.real_copy===undefined&&body.manifest?.data_source==='recent-copy')),'explicit_test_data_source_required');
  validateManifest(body.manifest);const digest=await hash(body.manifest);
  await db.batch([
    db.prepare('INSERT INTO generations VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(body.generation,digest,JSON.stringify(body.manifest)),
    db.prepare('INSERT INTO publish_guard SELECT CASE WHEN payload_hash=? THEN 1 ELSE 0 END FROM generations WHERE id=?').bind(digest,body.generation),
    db.prepare('DELETE FROM publish_guard')]);
  const uploaded=(await db.prepare('SELECT table_name,chunk_index FROM metadata_chunks WHERE generation=? ORDER BY table_name,chunk_index').bind(body.generation).all()).results;
  return {begun:true,generation:body.generation,manifest_hash:digest,uploaded};
}
export async function generationManifest(db,generation){
  const row=await db.prepare('SELECT tables_json,payload_hash FROM generations WHERE id=?').bind(generation).first();
  requireThat(row,'generation_missing',404);const manifest=JSON.parse(row.tables_json);validateManifest(manifest,{historical:true});return {manifest,hash:row.payload_hash};
}
function validateRows(name,rows){
  for(const row of rows){requireThat(Array.isArray(row)&&row.length===headers[name].length&&row.every(v=>typeof v==='string')&&bytes(row)<=ROW_BYTES,'invalid_chunk_row');
    if(name==='Papers')requireThat(/^[1-9][0-9]{0,8}$/.test(row[0]),'invalid_metadata_pmid');
    if(name==='Issues'){validKey(row[0]);requireThat(row[0]===JSON.stringify([row[1],row[2]]),'invalid_issue_identity');const ids=JSON.parse(row[4]);requireThat(Array.isArray(ids)&&new Set(ids).size===ids.length&&ids.every(id=>typeof id==='string'&&/^[1-9][0-9]{0,8}$/.test(id)),'invalid_issue_members');}
    if(name==='Texts')requireThat(/^\d+$/.test(row[1])&&Number.isSafeInteger(Number(row[1])),'invalid_text_part');
    if(name==='IssueCandidates'){validKey(row[0]);requireThat(/^\d+$/.test(row[3]),'invalid_candidate_position');}
  }
}
export async function upload(db,body){
  requireThat(metadataNames.includes(body.table_name)&&Number.isSafeInteger(body.index)&&body.index>=0&&Array.isArray(body.rows),'invalid_chunk');
  const {manifest}=await generationManifest(db,body.generation),name=body.table_name,c=manifest.tables[name].chunks[body.index];
  requireThat(c&&c.count===body.rows.length&&c.bytes===bytes(body.rows),'chunk_count_or_size_mismatch');
  validateRows(name,body.rows);requireThat(await hash(body.rows)===c.sha256,'chunk_hash_mismatch');
  const existing=await db.prepare('SELECT chunk_hash FROM metadata_chunks WHERE generation=? AND table_name=? AND chunk_index=?').bind(body.generation,name,body.index).first();
  if(existing){requireThat(existing.chunk_hash===c.sha256,'chunk_conflict',409);await readChunk(db,{...body},{requireReady:false});return {uploaded:true,replayed:true};}
  const data=JSON.stringify(body.rows),g=body.generation;
  const statements=[db.prepare('INSERT INTO metadata_chunks VALUES(?,?,?,?,?,?)').bind(g,name,c.index,c.sha256,c.offset,c.count),
    db.prepare(`INSERT INTO metadata_records SELECT ?,?,?+CAST(key AS INTEGER),?,json(value),
      CASE WHEN ? IN ('Appearances','IssueCandidates') THEN json_extract(value,'$[1]') ELSE json_extract(value,'$[0]') END,
      CASE WHEN ?='Appearances' THEN json_array(json_extract(value,'$[2]'),json_extract(value,'$[3]'))
      WHEN ?='IssueCandidates' THEN json_extract(value,'$[0]') ELSE '' END FROM json_each(?)`).bind(g,name,c.offset,c.index,name,name,name,data)];
  if(name==='Papers')statements.push(db.prepare(`INSERT INTO papers SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)`).bind(g,data));
  if(name==='Issues')statements.push(db.prepare(`INSERT INTO issues SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[5]') FROM json_each(?)`).bind(g,data),
    db.prepare(`INSERT INTO members SELECT ?,json_extract(i.value,'$[0]'),p.value FROM json_each(?) i,json_each(json_extract(i.value,'$[4]')) p`).bind(g,data));
  // A concurrent identical upload may win; only accept its fully committed matching chunk.
  try{await db.batch(statements);}catch(e){const saved=await db.prepare('SELECT chunk_hash FROM metadata_chunks WHERE generation=? AND table_name=? AND chunk_index=?').bind(g,name,c.index).first();if(saved?.chunk_hash!==c.sha256)throw e;}
  await readChunk(db,body,{requireReady:false});
  return {uploaded:true,replayed:false};
}
export async function readChunk(db,body,{requireReady=true}={}){
  const {manifest}=await generationManifest(db,body.generation),spec=manifest.tables[body.table_name],c=spec?.chunks[body.index];
  requireThat(c,'chunk_missing',404);
  if(requireReady)requireThat(await db.prepare('SELECT generation FROM generation_ready WHERE generation=?').bind(body.generation).first(),'generation_not_ready',409);
  const {results}=await db.prepare('SELECT row_json FROM metadata_records WHERE generation=? AND table_name=? AND row_index>=? AND row_index<? ORDER BY row_index')
    .bind(body.generation,body.table_name,c.offset,c.offset+c.count).all();
  const rows=results.map(r=>JSON.parse(r.row_json));
  requireThat(rows.length===c.count&&await hash(rows)===c.sha256,'chunk_not_complete',409);
  return {table_name:body.table_name,index:body.index,rows};
}
async function sourceRows(db,g,name,key,parent=false){
  const {results}=await db.prepare(`SELECT row_json FROM metadata_records INDEXED BY ${parent?'metadata_parent':'metadata_entity'} WHERE generation=? AND table_name=? AND ${parent?'parent_key':'entity_key'}=? ORDER BY row_index`).bind(g,name,key).all();
  return results.map(r=>JSON.parse(r.row_json));
}
export async function buildIssue(db,g,key){
  const source=await sourceRows(db,g,'Issues',key);requireThat(source.length===1,'issue_source_missing',409);const raw=records([headers.Issues,...source])[0];
  const apps=await sourceRows(db,g,'Appearances',key,true),candidates=await sourceRows(db,g,'IssueCandidates',key,true);
  const ids=JSON.parse(raw.pmids),snapshotIds=[...new Set(apps.map(a=>a[0]))].sort();
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(snapshotIds)));
  const content=btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  requireThat(raw.content_version.replace(/=+$/,'')===content&&ids.length===new Set(apps.map(a=>a[1])).size&&apps.every(a=>ids.includes(a[1])),'issue_content_mismatch',409);
  const papers=(await db.prepare(`SELECT r.row_json FROM members m CROSS JOIN metadata_records r INDEXED BY metadata_entity ON r.generation=m.generation
    AND r.table_name='Papers' AND r.entity_key=m.pmid WHERE m.generation=? AND m.issue_key=?`).bind(g,key).all()).results.map(r=>JSON.parse(r.row_json));
  requireThat(papers.length===ids.length,'issue_papers_missing',409);
  requireThat(new Set(candidates.map(c=>c[1])).size===candidates.length&&candidates.every(c=>apps.some(a=>a[0]===c[2]&&a[1]===c[1]&&a[9]===c[8])),'candidate_snapshot_mismatch',409);
  const {info,items}=listProjection({Papers:[headers.Papers,...papers],Appearances:[headers.Appearances,...apps],IssueCandidates:[headers.IssueCandidates,...candidates]},raw);
  requireThat(bytes(info)+bytes(items)<=CHUNK_BYTES,'issue_projection_too_large',413);
  await db.prepare('INSERT OR IGNORE INTO issue_lists VALUES(?,?,?,?)').bind(g,key,JSON.stringify(info),JSON.stringify(items)).run();
}
export async function buildPage(db,body){
  const {manifest}=await generationManifest(db,body.generation);requireThat(Number.isSafeInteger(body.offset)&&body.offset>=0,'invalid_build_offset');
  const rows=(await db.prepare(`SELECT issue_key FROM issues WHERE generation=? ORDER BY issue_key LIMIT 5 OFFSET ?`).bind(body.generation,body.offset).all()).results;
  for(const row of rows)await buildIssue(db,body.generation,row.issue_key);
  const total=manifest.tables.Issues.count;return {built:rows.length,next:body.offset+rows.length,total,done:body.offset+rows.length>=total};
}
export async function finish(db,body){
  const g=body.generation,{manifest,hash:root}=await generationManifest(db,g);
  const actual=(await db.prepare('SELECT table_name,count(*) chunks,sum(row_count) rows FROM metadata_chunks WHERE generation=? GROUP BY table_name').bind(g).all()).results;
  requireThat(actual.every(a=>metadataNames.includes(a.table_name)),'unexpected_metadata_table',409);
  const recordCounts=(await db.prepare('SELECT table_name,count(*) rows FROM metadata_records WHERE generation=? GROUP BY table_name').bind(g).all()).results;
  requireThat(recordCounts.every(a=>metadataNames.includes(a.table_name)),'unexpected_metadata_record',409);
  for(const name of metadataNames){const a=actual.find(r=>r.table_name===name),s=manifest.tables[name],n=recordCounts.find(r=>r.table_name===name)?.rows??0;
    requireThat((a?.chunks??0)===s.chunks.length&&(a?.rows??0)===s.count&&n===s.count,'generation_incomplete',409);}
  const bad=await db.prepare(`SELECT
    (SELECT count(*) FROM metadata_records r WHERE r.generation=? AND r.table_name='Appearances' AND (
      NOT EXISTS(SELECT 1 FROM papers p WHERE p.generation=r.generation AND p.pmid=r.entity_key) OR
      NOT EXISTS(SELECT 1 FROM metadata_records t INDEXED BY metadata_entity WHERE t.generation=r.generation AND t.table_name='Texts' AND t.entity_key=json_extract(r.row_json,'$[9]')) OR
      NOT EXISTS(SELECT 1 FROM issues i WHERE i.generation=r.generation AND i.issue_key=r.parent_key))) missing,
    (SELECT count(*) FROM issue_lists WHERE generation=?) projections`).bind(g,g).first();
  requireThat(!bad.missing&&bad.projections===manifest.tables.Issues.count,'generation_relations_incomplete',409);
  const invalidText=await db.prepare(`SELECT entity_key FROM metadata_records WHERE generation=? AND table_name='Texts'
    GROUP BY entity_key HAVING min(CAST(json_extract(row_json,'$[1]') AS INTEGER))<>0 OR
      count(*)<>max(CAST(json_extract(row_json,'$[1]') AS INTEGER))+1 OR count(*)<>count(DISTINCT json_extract(row_json,'$[1]')) LIMIT 1`).bind(g).first();
  requireThat(!invalidText,'text_parts_incomplete',409);
  const duplicates=await db.prepare(`SELECT EXISTS(SELECT 1 FROM metadata_records WHERE generation=? AND table_name IN ('Appearances','TextRows','IssueCandidateRows')
    GROUP BY table_name,json_extract(row_json,'$[0]') HAVING count(*)>1) duplicate,
    EXISTS(SELECT 1 FROM metadata_records c WHERE c.generation=? AND c.table_name='IssueCandidates'
      AND NOT EXISTS(SELECT 1 FROM issues i WHERE i.generation=c.generation AND i.issue_key=c.parent_key)) orphan_candidate`).bind(g,g).first();
  requireThat(!duplicates.duplicate&&!duplicates.orphan_candidate,'duplicate_or_orphan_metadata',409);
  const indexes=await db.prepare(`SELECT
    (SELECT count(*) FROM metadata_records r WHERE r.generation=? AND r.table_name='TextRows' AND (
      CAST(json_extract(r.row_json,'$[1]') AS INTEGER) IS NOT (SELECT min(t.row_index)+2 FROM metadata_records t INDEXED BY metadata_entity WHERE t.generation=r.generation AND t.table_name='Texts' AND t.entity_key=r.entity_key) OR
      CAST(json_extract(r.row_json,'$[2]') AS INTEGER) IS NOT (SELECT count(*) FROM metadata_records t INDEXED BY metadata_entity WHERE t.generation=r.generation AND t.table_name='Texts' AND t.entity_key=r.entity_key))) bad_text,
    (SELECT count(*) FROM metadata_records r WHERE r.generation=? AND r.table_name='IssueCandidateRows' AND (
      CAST(json_extract(r.row_json,'$[1]') AS INTEGER) IS NOT (SELECT min(c.row_index)+2 FROM metadata_records c INDEXED BY metadata_parent WHERE c.generation=r.generation AND c.table_name='IssueCandidates' AND c.parent_key=r.entity_key) OR
      CAST(json_extract(r.row_json,'$[2]') AS INTEGER) IS NOT (SELECT count(*) FROM metadata_records c INDEXED BY metadata_parent WHERE c.generation=r.generation AND c.table_name='IssueCandidates' AND c.parent_key=r.entity_key))) bad_candidates,
    (SELECT count(DISTINCT entity_key) FROM metadata_records WHERE generation=? AND table_name='Texts') texts,
    (SELECT count(DISTINCT parent_key) FROM metadata_records WHERE generation=? AND table_name='IssueCandidates') candidate_groups`).bind(g,g,g,g).first();
  requireThat(!indexes.bad_text&&!indexes.bad_candidates&&indexes.texts===manifest.tables.TextRows.count&&indexes.candidate_groups===manifest.tables.IssueCandidateRows.count,'metadata_indexes_incomplete',409);
  if(['real-copy','recent-copy'].includes(manifest.data_source)){
    const safety=await db.prepare(`SELECT
      EXISTS(SELECT 1 FROM papers a JOIN papers b ON a.pmid=b.pmid JOIN generations z ON z.id=b.generation WHERE a.generation=? AND b.generation<>a.generation AND ((?='real-copy' AND json_extract(z.tables_json,'$.data_source') IS NOT 'recent-copy') OR json_extract(z.tables_json,'$.data_source') IS NULL)) paper_collision,
      EXISTS(SELECT 1 FROM issues a JOIN issues b ON a.issue_key=b.issue_key JOIN generations z ON z.id=b.generation WHERE a.generation=? AND b.generation<>a.generation AND ((?='real-copy' AND json_extract(z.tables_json,'$.data_source') IS NOT 'recent-copy') OR json_extract(z.tables_json,'$.data_source') IS NULL)) issue_collision,
      EXISTS(SELECT 1 FROM metadata_records WHERE generation=? AND table_name='Issues' AND
        (json_extract(row_json,'$[3]')<? OR json_extract(row_json,'$[3]')>?)) outside_window`).bind(g,manifest.data_source,g,manifest.data_source,g,manifest.trial_window.from,manifest.trial_window.through).first();
    requireThat(!safety.paper_collision&&!safety.issue_collision&&!safety.outside_window,'trial_collision_or_date_mismatch',409);
  }
  await db.prepare('INSERT INTO generation_ready VALUES(?,?) ON CONFLICT(generation) DO NOTHING').bind(g,root).run();
  return {ready:true,generation:g,manifest_hash:root};
}

export async function rebuildGeneration(db,g){
  const row=await db.prepare('SELECT tables_json,payload_hash FROM generations WHERE id=?').bind(g).first();
  const stored=JSON.parse(row.tables_json);requireThat(await hash(stored)===row.payload_hash,'metadata_checksum_mismatch');
  if(stored.format!==FORMAT){
    const t=stored;
    await db.batch([
      db.prepare(`INSERT INTO papers SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)`).bind(g,JSON.stringify(t.Papers.slice(1))),
      db.prepare(`INSERT INTO issues SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[5]') FROM json_each(?)`).bind(g,JSON.stringify(t.Issues.slice(1))),
      db.prepare(`INSERT INTO members SELECT ?,json_extract(i.value,'$[0]'),p.value FROM json_each(?) i,json_each(json_extract(i.value,'$[4]')) p`).bind(g,JSON.stringify(t.Issues.slice(1)))
    ]);
    for(const raw of records(t.Issues)){const {info,items}=listProjection(t,raw);await db.prepare('INSERT INTO issue_lists VALUES(?,?,?,?)').bind(g,raw.issue_key,JSON.stringify(info),JSON.stringify(items)).run();}
    return;
  }
  validateManifest(stored,{historical:true});
  for(const name of metadataNames)for(const c of stored.tables[name].chunks){
    const registered=await db.prepare('SELECT chunk_hash,row_offset,row_count FROM metadata_chunks WHERE generation=? AND table_name=? AND chunk_index=?').bind(g,name,c.index).first();
    requireThat(registered?.chunk_hash===c.sha256&&registered.row_offset===c.offset&&registered.row_count===c.count,'chunk_descriptor_mismatch');
    const part=await readChunk(db,{generation:g,table_name:name,index:c.index},{requireReady:false});validateRows(name,part.rows);
    const storedRows=(await db.prepare('SELECT row_index,chunk_index,entity_key,parent_key FROM metadata_records WHERE generation=? AND table_name=? AND chunk_index=? ORDER BY row_index').bind(g,name,c.index).all()).results;
    requireThat(storedRows.length===part.rows.length&&storedRows.every((r,i)=>{const a=part.rows[i];return r.row_index===c.offset+i&&r.chunk_index===c.index&&r.entity_key===(['Appearances','IssueCandidates'].includes(name)?a[1]:a[0])&&r.parent_key===(name==='Appearances'?JSON.stringify([a[2],a[3]]):name==='IssueCandidates'?a[0]:'');}),'record_lookup_mismatch');
  }
  await db.batch([
    db.prepare(`INSERT INTO papers SELECT generation,entity_key,json_extract(row_json,'$[1]') FROM metadata_records WHERE generation=? AND table_name='Papers'`).bind(g),
    db.prepare(`INSERT INTO issues SELECT generation,entity_key,json_extract(row_json,'$[5]') FROM metadata_records WHERE generation=? AND table_name='Issues'`).bind(g),
    db.prepare(`INSERT INTO members SELECT r.generation,r.entity_key,p.value FROM metadata_records r,json_each(json_extract(r.row_json,'$[4]')) p WHERE r.generation=? AND r.table_name='Issues'`).bind(g)
  ]);
  for(let offset=0;offset<stored.tables.Issues.count;offset+=5)await buildPage(db,{generation:g,offset});
  await finish(db,{generation:g});
}
export async function chunkedDetail(db,r,revision){
  if(revision===undefined)revision=(await db.prepare('SELECT generation FROM settings WHERE id=1').first()).generation;
  const {results}=await db.prepare(`SELECT a.row_json appearance,
    (SELECT json_group_array(json(row_json)) FROM (SELECT t.row_json FROM metadata_records t INDEXED BY metadata_entity
      WHERE t.generation=a.generation AND t.table_name='Texts' AND t.entity_key=json_extract(a.row_json,'$[9]')
      ORDER BY CAST(json_extract(t.row_json,'$[1]') AS INTEGER))) parts
    FROM metadata_records a INDEXED BY metadata_entity
    WHERE a.generation=? AND a.table_name='Appearances' AND a.entity_key=? AND (?='' OR a.parent_key=?)
    ORDER BY a.row_index`).bind(revision,r.pmid,r.issue_key||'',r.issue_key||'').all();
  requireThat(results.length,'paper_missing',404);
  const appearances=[];
  for(const row of results){const a=JSON.parse(row.appearance),parts=JSON.parse(row.parts);
    requireThat(parts.length&&parts.every((p,i)=>Number(p[1])===i),'text_parts_incomplete',409);
    appearances.push({...records([headers.Appearances,a])[0],text:JSON.parse(parts.map(p=>p[2]).join(''))});}
  appearances.sort((a,b)=>b.delivered_date.localeCompare(a.delivered_date)||a.issue_id.localeCompare(b.issue_id));
  return {revision,appearances};
}
