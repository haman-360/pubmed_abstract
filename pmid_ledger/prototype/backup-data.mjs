// A fixed, local-only format. No SQL, paths or credentials are read from the backup.
export const backupColumns = {
  generations:['id','payload_hash','tables_json'],
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
export async function exportBackup(db) {
  const selects=names.map(n=>`(SELECT json_group_array(json_array(${backupColumns[n].join(',')})) FROM ${n}) AS ${n}`);
  const row=await db.prepare(`SELECT generation AS active_revision,${selects.join(',')} FROM settings WHERE id=1`).first();
  const tables=Object.fromEntries(names.map(n=>[n,JSON.parse(row[n]).map(r=>[stable(r),r]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(x=>x[1])]));
  const payload={format:'LOCAL_SYNTHETIC_D1_BACKUP_V1',synthetic:true,active_revision:row.active_revision,tables};
  return {payload,sha256:await digestBackup(payload)};
}
export async function validateBackup(backup) {
  const p=backup?.payload;
  check(p?.format==='LOCAL_SYNTHETIC_D1_BACKUP_V1'&&p.synthetic===true,'invalid_backup_format');
  check(await digestBackup(p)===backup.sha256,'backup_checksum_mismatch');
  check(p.tables&&Object.keys(p.tables).length===names.length&&names.every(n=>Array.isArray(p.tables[n])),'invalid_backup_tables');
  for(const n of names)for(const row of p.tables[n])check(Array.isArray(row)&&row.length===backupColumns[n].length&&row.every(v=>typeof v==='string'||Number.isSafeInteger(v)),'invalid_backup_row');
  const objects=n=>p.tables[n].map(r=>Object.fromEntries(backupColumns[n].map((k,i)=>[k,r[i]])));
  const generations=objects('generations');
  check(p.active_revision===null||generations.some(g=>g.id===p.active_revision),'invalid_active_revision');
  for(const g of generations)check(await digestBackup(JSON.parse(g.tables_json))===g.payload_hash,'invalid_metadata_hash');
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
  for(const n of names){
    const cols=backupColumns[n];
    statements.push(db.prepare(`INSERT INTO ${n} (${cols.join(',')}) SELECT ${cols.map((_,i)=>`json_extract(value,'$[${i}]')`).join(',')} FROM json_each(?)`).bind(JSON.stringify(p.tables[n])));
  }
  statements.push(db.prepare('UPDATE settings SET generation=? WHERE id=1').bind(p.active_revision),
    ...triggerStatements.map(sql=>db.prepare(sql)),db.prepare('DELETE FROM publish_guard'));
  if(simulateFailure)statements.push(db.prepare('INSERT INTO publish_guard VALUES(0)'));
  await db.batch(statements);
  const verified=await exportBackup(db);
  check(verified.sha256===backup.sha256,'restore_readback_mismatch');
  return {restored:true,revision:p.active_revision};
}
