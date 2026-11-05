import {requireThat} from './metadata.mjs';
const DAY=86400000;
export function browseWindow(now=new Date()){
  const today=new Date(now.getTime()+9*3600000).toISOString().slice(0,10);
  const [year,month,day]=today.split('-').map(Number),target=new Date(Date.UTC(year,month-3,1));
  const last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  target.setUTCDate(Math.min(day,last));
  return {from:target.toISOString().slice(0,10),through:today};
}
export function browseRange(r,now){
  const scope=r.scope??'recent',recent=browseWindow(now);
  if(scope==='recent')return {scope,...recent};
  if(scope==='month'){
    requireThat(typeof r.month==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(r.month),'invalid_archive_month');
    const [y,m]=r.month.split('-').map(Number);requireThat(y>=1900&&y<=9998,'invalid_archive_month');
    return {scope,from:r.month+'-01',through:r.month+'-'+String(new Date(Date.UTC(y,m,0)).getUTCDate()).padStart(2,'0')};
  }
  requireThat(['unknown','all'].includes(scope),'invalid_browse_scope');return {scope,...recent};
}
export async function browseIssues(db,r,now=new Date()){
  const range=browseRange(r,now),offset=r.offset??0;
  requireThat(Number.isSafeInteger(offset)&&offset>=0,'invalid_offset');
  const revision=(await db.prepare('SELECT generation FROM settings WHERE id=1').first()).generation;
  requireThat(revision,'metadata_not_seeded',409);
  const date="json_extract(info_json,'$.delivered_date')";
  const filter=range.scope==='all'?'1':range.scope==='unknown'?`${date}=''`:`${date}>=? AND ${date}<=?`;
  const args=[revision,...(['recent','month'].includes(range.scope)?[range.from,range.through]:[])];
  const {total}=await db.prepare(`SELECT count(*) total FROM issue_lists INDEXED BY issue_lists_date WHERE generation=? AND ${filter}`).bind(...args).first();
  const start=offset<total?offset:Math.max(0,Math.floor((total-1)/20)*20);
  // Select indexed keys first; progress aggregation only touches the requested 20 deliveries.
  const {results}=await db.prepare(`WITH selected AS MATERIALIZED (
    SELECT issue_key FROM issue_lists INDEXED BY issue_lists_date WHERE generation=? AND ${filter}
    ORDER BY ${date} DESC,json_extract(info_json,'$.issue_id') DESC,json_extract(info_json,'$.topic') LIMIT 20 OFFSET ?)
    SELECT v.item_json FROM selected k CROSS JOIN issue_states v ON v.issue_key=k.issue_key AND v.revision=?
    ORDER BY json_extract(v.item_json,'$.delivered_date') DESC,json_extract(v.item_json,'$.issue_id') DESC,json_extract(v.item_json,'$.topic')`)
    .bind(...args,start,revision).all();
  const after=(await db.prepare('SELECT generation FROM settings WHERE id=1').first()).generation;
  requireThat(after===revision,'metadata_changed_reload',409);
  return {items:results.map(row=>{const {scores_available,...i}=JSON.parse(row.item_json);return i;}),total,offset:start,page_size:20,revision,window:range};
}
export function readLimit(error,now=new Date()){
  // Exact D1 quota phrases only. Generic SQL, CPU, syntax or capacity errors are not a daily limit.
  const text=[error?.message,error?.cause?.message].filter(v=>typeof v==='string').join('\n');
  if(!/exceeded D1's free tier daily row (?:read|write) limit/i.test(text))return null;
  return {error:'daily_d1_limit',message:'本日の無料枠の上限に達しました。24時間後にもう一度アクセスしてください。',
    retry_after_seconds:DAY/1000,retry_at:new Date(now.getTime()+DAY).toISOString()};
}
