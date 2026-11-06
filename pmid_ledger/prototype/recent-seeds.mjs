// Source states initialize missing TEST state only. Existing TEST edits always win.
import {requireThat,hash} from './metadata.mjs';
import {operationRequest} from './operations.mjs';
export async function seedMissing(db,body,kind){
  requireThat(/^[a-f0-9]{64}$/.test(body.revision??'')&&Array.isArray(body.items)&&body.items.length<=10,'invalid_source_seed');
  const source=await db.prepare("SELECT json_extract(g.tables_json,'$.data_source') source FROM generations g JOIN settings s ON s.generation=g.id WHERE g.id=?").bind(body.revision).first();
  requireThat(source?.source==='recent-copy','recent_generation_required',409);
  const entries=[],keys=new Set(),now=new Date().toISOString();
  for(const item of body.items){
    const key=kind==='reviews'?item.pmid:item.issue_key;requireThat(!keys.has(key),'duplicate_source_seed');keys.add(key);
    const operation_id='source-'+await hash([body.revision,kind,item]);
    const request=operationRequest({operation_id,revision:body.revision,...(kind==='reviews'?{changes:[{pmid:item.pmid,status:item.status,note:item.note,expected_version:0}]}:{issue_key:item.issue_key,status:item.status,content_version:item.content_version,expected_version:0})},kind);
    entries.push([operation_id,await hash(request),JSON.stringify(request),now,key]);
  }
  if(!entries.length)return {seeded:0};
  const table=kind==='reviews'?'review_current':'issue_current',column=kind==='reviews'?'pmid':'issue_key';
  const result=await db.prepare(`INSERT INTO operations
    SELECT json_extract(j.value,'$[0]'),json_extract(j.value,'$[1]'),json_extract(j.value,'$[2]'),json_extract(j.value,'$[3]')
    FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM ${table} c WHERE c.${column}=json_extract(j.value,'$[4]'))
    AND (?='reviews' OR json_extract(json_extract(j.value,'$[2]'),'$.status')<>'completed' OR NOT EXISTS(
      SELECT 1 FROM members m LEFT JOIN review_current c ON c.pmid=m.pmid WHERE m.generation=?
      AND m.issue_key=json_extract(j.value,'$[4]') AND COALESCE(c.status,'unreviewed')='unreviewed'))`).bind(JSON.stringify(entries),kind,body.revision).run();
  if(kind==='reviews'){
    const count=await db.prepare('SELECT count(*) n FROM review_current WHERE pmid IN (SELECT value FROM json_each(?))').bind(JSON.stringify([...keys])).first();
    requireThat(count.n===entries.length,'source_seed_readback_mismatch',409);
  }
  return {checked:entries.length,changed:result.meta.changes>0};
}
export async function recentStatus(db){
  const row=await db.prepare(`SELECT s.generation revision,g.payload_hash,g.tables_json,
    (SELECT COALESCE(sum(length(CAST(row_json AS BLOB))),0) FROM metadata_records) stored_bytes,
    (SELECT COALESCE(max(rowid),0) FROM operations) cutoff
    FROM settings s LEFT JOIN generations g ON s.generation=g.id WHERE s.id=1`).first();
  const manifest=row.tables_json?JSON.parse(row.tables_json):null;
  requireThat(!manifest||['real-copy','recent-copy'].includes(manifest.data_source),'real_test_baseline_required',409);
  return {revision:row.revision,payload_hash:row.payload_hash,manifest,stored_bytes:row.stored_bytes,cutoff:row.cutoff};
}
