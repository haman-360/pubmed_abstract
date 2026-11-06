import {requireThat} from './metadata.mjs';

// Deliberately independent of the current metadata generation and issue completion.
// A changing ledger invalidates the entire export instead of producing a mixed file.
export async function wantedPage(db,r){
  const after=r.after??'';
  requireThat(after===''||/^[1-9][0-9]{0,8}$/.test(after),'invalid_export_cursor');
  requireThat(r.cutoff===undefined||(Number.isSafeInteger(r.cutoff)&&r.cutoff>=0),'invalid_export_snapshot');
  requireThat(after===''||r.cutoff!==undefined,'export_snapshot_required');
  const row=await db.prepare(`SELECT (SELECT COALESCE(max(rowid),0) FROM operations) cutoff,
    (SELECT json_group_array(pmid) FROM (SELECT pmid FROM review_current
      WHERE status='want_fulltext' AND pmid>? ORDER BY pmid LIMIT 501)) ids`).bind(after).first();
  requireThat(r.cutoff===undefined||row.cutoff===r.cutoff,'export_changed_restart',409);
  const all=JSON.parse(row.ids),ids=all.slice(0,500);
  return {pmids:ids,cutoff:row.cutoff,after:ids.at(-1)??after,done:all.length<=500};
}

// Sync reads only compact state, never memo/body/history, to decide what to import.
export async function queueStatePage(db,r){
  requireThat(['issues','reviews'].includes(r.kind),'invalid_queue_state_kind');
  requireThat(typeof (r.after??'')==='string'&&(r.after??'').length<=2000,'invalid_queue_state_cursor');
  const issue=r.kind==='issues',column=issue?'issue_key':'pmid',table=issue?'issue_current':'review_current';
  const rows=(await db.prepare(`SELECT ${issue?'issue_key,status,content_version':'pmid,status'} FROM ${table}
    WHERE ${column}>? ORDER BY ${column} LIMIT 501`).bind(r.after??'').all()).results;
  const items=rows.slice(0,500);
  return {items,after:items.at(-1)?.[column]??r.after??'',done:rows.length<=500};
}
