import {backupColumns} from './backup-data.mjs';
import {requireThat,hash} from './metadata.mjs';
export const STREAM_FORMAT='LOCAL_D1_STREAM_V2';
export const sourceColumns=Object.fromEntries(['generations','metadata_chunks','metadata_records','operations','operation_ids','review_events','issue_events'].map(n=>[n,backupColumns[n]]));
function filter(table,s){
  if(['generations','metadata_chunks','metadata_records'].includes(table))return {sql:`t.${table==='generations'?'id':'generation'} IN (SELECT value FROM json_each(?))`,args:[JSON.stringify(s.generations)]};
  if(table==='operations')return {sql:'t.rowid<=?',args:[s.cutoff]};
  return {sql:'EXISTS(SELECT 1 FROM operations o WHERE o.id=t.operation_id AND o.rowid<=?)',args:[s.cutoff]};
}
export function validateSnapshot(s){
  requireThat(s?.format===STREAM_FORMAT&&(s.synthetic===true||(s.synthetic===false&&s.test_only===true))&&JSON.stringify(s.columns)===JSON.stringify(sourceColumns),'invalid_backup_snapshot');
  requireThat(Array.isArray(s.generations)&&s.generations.every(g=>/^[a-f0-9]{64}$/.test(g))&&
    (s.active_revision===null||s.generations.includes(s.active_revision))&&Number.isSafeInteger(s.cutoff)&&s.cutoff>=0,'invalid_backup_boundary');
  requireThat(s.counts&&Object.keys(sourceColumns).every(n=>Number.isSafeInteger(s.counts[n])&&s.counts[n]>=0),'invalid_backup_counts');
}
export async function startBackup(db){
  const row=await db.prepare(`SELECT s.generation active_revision,(SELECT count(*) FROM generations WHERE json_extract(tables_json,'$.data_source')='real-copy') real_copies,(SELECT COALESCE(max(rowid),0) FROM operations) cutoff,
    (SELECT json_group_array(id) FROM (SELECT g.id FROM generations g WHERE json_extract(g.tables_json,'$.format') IS NOT 'LOCAL_D1_CHUNKS_V2'
    OR EXISTS(SELECT 1 FROM generation_ready r WHERE r.generation=g.id AND r.manifest_hash=g.payload_hash) ORDER BY g.id)) generations FROM settings s WHERE id=1`).first();
  const s={format:STREAM_FORMAT,synthetic:row.real_copies===0,...(row.real_copies?{test_only:true}:{}),active_revision:row.active_revision,cutoff:row.cutoff,generations:JSON.parse(row.generations),columns:sourceColumns,counts:{}};
  for(const name of Object.keys(sourceColumns)){const f=filter(name,s);s.counts[name]=(await db.prepare(`SELECT count(*) n FROM ${name} t WHERE ${f.sql}`).bind(...f.args).first()).n;}
  validateSnapshot(s);return s;
}
export async function backupPage(db,body){
  const s=body.snapshot;validateSnapshot(s);const name=body.table;
  requireThat(Object.hasOwn(sourceColumns,name)&&Number.isSafeInteger(body.cursor)&&body.cursor>=0,'invalid_backup_page');
  const f=filter(name,s),limit=['generations','operations'].includes(name)?1:128;
  // Walk rowid directly. A generation index plus ORDER BY rowid can rescan/sort the whole table per page.
  const {results}=await db.prepare(`SELECT t.rowid _cursor,${sourceColumns[name].map(c=>'t.'+c).join(',')} FROM ${name} t NOT INDEXED
    WHERE t.rowid>? AND ${f.sql} ORDER BY t.rowid LIMIT ?`).bind(body.cursor,...f.args,limit).all();
  const rows=[];let next=body.cursor,size=2;
  for(const result of results){const row=sourceColumns[name].map(c=>result[c]),length=new TextEncoder().encode(JSON.stringify(row)).byteLength;
    requireThat(length<=4000000,'backup_row_too_large',413);
    if(rows.length&&size+length+1>196608)break;rows.push(row);size+=length+1;next=result._cursor;
  }
  return {rows,next,done:rows.length===results.length&&results.length<limit,sha256:await hash(rows)};
}
