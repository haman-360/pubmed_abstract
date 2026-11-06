// A fixed, local-only format. No SQL, paths or credentials are read from the backup.
import {FORMAT,validateManifest} from './chunked.mjs';
export const backupColumns = {
  generations:['id','payload_hash','tables_json'],
  metadata_chunks:['generation','table_name','chunk_index','chunk_hash','row_offset','row_count'],
  metadata_records:['generation','table_name','row_index','chunk_index','row_json','entity_key','parent_key'],
  generation_ready:['generation','manifest_hash'],
  papers:['generation','pmid','title'],
  issues:['generation','issue_key','content_version'],
  members:['generation','issue_key','pmid'],
  issue_lists:['generation','issue_key','info_json','items_json'],
  operations:['id','request_hash','request_json','created_at'],
  operation_ids:['id','operation_id'],
  review_events:['operation_id','pmid','version','status','note','status_updated_at','updated_at'],
  review_current:['pmid','version','status','note','status_updated_at','updated_at'],
  issue_events:['operation_id','issue_key','version','status','content_version','updated_at'],
  issue_current:['issue_key','version','status','content_version','updated_at']
};
const names=Object.keys(backupColumns);
const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'
  ?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}':JSON.stringify(value);
export async function digestBackup(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
function check(ok,code) {if(!ok)throw Object.assign(new Error(code),{status:400});}
export async function exportBackup(db,{format='LOCAL_SYNTHETIC_D1_BACKUP_V2'}={}) {
  const size=await db.prepare(`SELECT (SELECT COALESCE(sum(length(CAST(row_json AS BLOB))),0) FROM metadata_records)
    +(SELECT COALESCE(sum(length(CAST(tables_json AS BLOB))),0) FROM generations)
    +(SELECT COALESCE(sum(length(CAST(note AS BLOB))),0) FROM review_events) bytes`).first();
  check(size.bytes<750000,'use_stream_backup');
  const selected=format.endsWith('_V1')?names.filter(n=>!['metadata_chunks','metadata_records','generation_ready'].includes(n)):names;
  const selects=selected.map(n=>`(SELECT json_group_array(json_array(${backupColumns[n].join(',')})) FROM ${n}) AS ${n}`);
  const row=await db.prepare(`SELECT generation AS active_revision,${selects.join(',')} FROM settings WHERE id=1`).first();
  const tables=Object.fromEntries(selected.map(n=>[n,JSON.parse(row[n]).map(r=>[stable(r),r]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(x=>x[1])]));
  const real=tables.generations.some(g=>JSON.parse(g[2]).data_source==='real-copy');
  const payload={format,synthetic:!real,...(real?{test_only:true}:{}),active_revision:row.active_revision,tables};
  return {payload,sha256:await digestBackup(payload)};
}
export async function validateBackup(backup) {
  const p=backup?.payload;
  check(['LOCAL_SYNTHETIC_D1_BACKUP_V1','LOCAL_SYNTHETIC_D1_BACKUP_V2'].includes(p?.format)&&(p.synthetic===true||(p.synthetic===false&&p.test_only===true)),'invalid_backup_format');
  check(await digestBackup(p)===backup.sha256,'backup_checksum_mismatch');
  const selected=p.format.endsWith('_V1')?names.filter(n=>!['metadata_chunks','metadata_records','generation_ready'].includes(n)):names;
  check(p.tables&&Object.keys(p.tables).length===selected.length&&selected.every(n=>Array.isArray(p.tables[n])),'invalid_backup_tables');
  for(const n of selected)for(const row of p.tables[n])check(Array.isArray(row)&&row.length===backupColumns[n].length&&row.every(v=>typeof v==='string'||Number.isSafeInteger(v)),'invalid_backup_row');
  const objects=n=>p.tables[n].map(r=>Object.fromEntries(backupColumns[n].map((k,i)=>[k,r[i]])));
  const generations=objects('generations');
  check(p.active_revision===null||generations.some(g=>g.id===p.active_revision),'invalid_active_revision');
  for(const g of generations)check(await digestBackup(JSON.parse(g.tables_json))===g.payload_hash,'invalid_metadata_hash');
  for(const g of generations){const manifest=JSON.parse(g.tables_json);if(manifest.format!==FORMAT)continue;
    check(!p.format.endsWith('_V1'),'chunked_backup_requires_v2');validateManifest(manifest,{historical:true});
    const chunks=objects('metadata_chunks').filter(c=>c.generation===g.id),rows=objects('metadata_records').filter(r=>r.generation===g.id),ready=objects('generation_ready').find(r=>r.generation===g.id);
    if(ready)check(ready.manifest_hash===g.payload_hash&&chunks.length===Object.values(manifest.tables).reduce((n,s)=>n+s.chunks.length,0),'invalid_ready_generation');
    check(rows.length===chunks.reduce((n,c)=>n+c.row_count,0),'invalid_chunk_record_count');
    for(const c of chunks){const expected=manifest.tables[c.table_name]?.chunks[c.chunk_index];
      check(expected&&c.chunk_hash===expected.sha256&&c.row_count===expected.count&&c.row_offset===expected.offset,'invalid_chunk_descriptor');
      const data=rows.filter(r=>r.table_name===c.table_name&&r.chunk_index===c.chunk_index).sort((a,b)=>a.row_index-b.row_index);
      check(data.length===expected.count&&data.every((r,i)=>r.row_index===expected.offset+i)&&await digestBackup(data.map(r=>JSON.parse(r.row_json)))===expected.sha256,'invalid_chunk_data');
    }
  }
  const operations=objects('operations'),opMap=new Map(operations.map(o=>[o.id,o]));
  check(opMap.size===operations.length,'duplicate_operation');
  const expectedIds=[];
  for(const o of operations){
    const r=JSON.parse(o.request_json);
    check(r.operation_id===o.id&&await digestBackup(r)===o.request_hash&&Array.isArray(r.changes)&&r.changes.length<=100,'invalid_operation_hash');
    expectedIds.push([o.id,o.id]);if(r.review_operation_id)expectedIds.push([r.review_operation_id,o.id]);
    const reviews=objects('review_events').filter(e=>e.operation_id===o.id);
    check(reviews.length===r.changes.length&&r.changes.every(c=>reviews.some(e=>e.pmid===c.pmid&&e.version===c.expected_version+1&&e.status===c.status&&e.note===c.note&&e.updated_at===o.created_at)),'operation_review_mismatch');
    const events=objects('issue_events').filter(e=>e.operation_id===o.id);
    check(events.length===(r.kind==='reviews'?0:1)&&events.every(e=>e.issue_key===r.issue_key&&e.version===r.expected_version+1&&e.status===r.status&&e.content_version===r.content_version&&e.updated_at===o.created_at),'operation_issue_mismatch');
  }
  check(stable(expectedIds.sort())===stable([...p.tables.operation_ids].sort()),'operation_ids_mismatch');
  for(const [eventName,currentName,key,allowed]of [
    ['review_events','review_current','pmid',['unreviewed','reviewed_no_fulltext','want_fulltext','fulltext_obtained','read']],
    ['issue_events','issue_current','issue_key',['unreviewed','in_progress','completed']]
  ]){
    const latest=new Map();
    for(const e of objects(eventName).sort((a,b)=>a.version-b.version)){
      const before=latest.get(e[key]);
      check(opMap.has(e.operation_id)&&e.version===(before?.version??0)+1&&allowed.includes(e.status),'invalid_event_sequence');
      if(eventName==='review_events')check(e.note.length<=2000&&e.status_updated_at===((before?.status??'unreviewed')===e.status?(before?.status_updated_at??''):e.updated_at),'invalid_review_history');
      const {operation_id,...state}=e;latest.set(e[key],state);
    }
    check(stable([...latest.values()].map(stable).sort())===stable(objects(currentName).map(stable).sort()),'current_state_mismatch');
  }
  return p;
}
export async function restoreBackup(db,backup,triggerStatements,{simulateFailure=false}={}) {
  const p=await validateBackup(backup);
  const empty=names.map(n=>`(SELECT count(*) FROM ${n})`).join('+');
  const statements=[db.prepare(`INSERT INTO publish_guard VALUES((SELECT CASE WHEN generation IS NULL AND (${empty})=0 THEN 1 ELSE 0 END FROM settings WHERE id=1))`),
    db.prepare('DROP TRIGGER apply_operation'),db.prepare('DROP TRIGGER operation_hash_guard')];
  for(const n of names.filter(n=>p.tables[n])){
    const cols=backupColumns[n];
    statements.push(db.prepare(`INSERT INTO ${n} (${cols.join(',')}) SELECT ${cols.map((_,i)=>`json_extract(value,'$[${i}]')`).join(',')} FROM json_each(?)`).bind(JSON.stringify(p.tables[n])));
  }
  statements.push(db.prepare('UPDATE settings SET generation=? WHERE id=1').bind(p.active_revision),
    ...triggerStatements.map(sql=>db.prepare(sql)),db.prepare('DELETE FROM publish_guard'));
  if(simulateFailure)statements.push(db.prepare('INSERT INTO publish_guard VALUES(0)'));
  await db.batch(statements);
  const verified=await exportBackup(db,{format:p.format});
  check(verified.sha256===backup.sha256,'restore_readback_mismatch');
  return {restored:true,revision:p.active_revision};
}
