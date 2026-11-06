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
  const date="json_extract(info_json,'$.delivered_date')";
  const filter=range.scope==='all'?'1':range.scope==='unknown'?`${date}=''`:`${date}>=? AND ${date}<=?`;
  const args=['recent','month'].includes(range.scope)?[range.from,range.through]:[];
  // One SQL snapshot fixes the generation, count and page together. Only 20 selected keys reach progress aggregation.
  const row=await db.prepare(`WITH current AS MATERIALIZED (SELECT generation revision FROM settings WHERE id=1),
    totals AS (SELECT count(*) total FROM issue_lists INDEXED BY issue_lists_date
      WHERE generation=(SELECT revision FROM current) AND ${filter}),
    paging AS (SELECT total,CASE WHEN ?<total THEN ? ELSE max(0,CAST((total-1)/20 AS INTEGER)*20) END offset FROM totals),
    selected AS MATERIALIZED (SELECT issue_key FROM issue_lists INDEXED BY issue_lists_date
      WHERE generation=(SELECT revision FROM current) AND ${filter}
      ORDER BY ${date} DESC,json_extract(info_json,'$.issue_id') DESC,json_extract(info_json,'$.topic')
      LIMIT 20 OFFSET (SELECT offset FROM paging))
    SELECT current.revision,paging.total,paging.offset,(SELECT json_group_array(json(item_json)) FROM (
      SELECT v.item_json FROM selected k CROSS JOIN issue_states v ON v.issue_key=k.issue_key AND v.revision=current.revision
      ORDER BY json_extract(v.item_json,'$.delivered_date') DESC,json_extract(v.item_json,'$.issue_id') DESC,json_extract(v.item_json,'$.topic'))) items
    FROM current,paging`).bind(...args,offset,offset,...args).first();
  requireThat(row?.revision,'metadata_not_seeded',409);
  return {items:JSON.parse(row.items).map(({scores_available,...i})=>i),total:row.total,offset:row.offset,page_size:20,revision:row.revision,window:range};
}
export function readLimit(error,now=new Date()){
  // Exact D1 quota phrases only. Generic SQL, CPU, syntax or capacity errors are not a daily limit.
  const text=[error?.message,error?.cause?.message].filter(v=>typeof v==='string').join('\n');
  if(!/exceeded D1's free tier daily row (?:read|write) limit/i.test(text))return null;
  return {error:'daily_d1_limit',message:'本日の無料枠の上限に達しました。24時間後にもう一度アクセスしてください。',
    retry_after_seconds:DAY/1000,retry_at:new Date(now.getTime()+DAY).toISOString()};
}
