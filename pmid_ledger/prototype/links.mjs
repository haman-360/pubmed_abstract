import {requireThat,validKey} from './metadata.mjs';

export function linkTarget(value){
  requireThat(value&&typeof value==='object','invalid_ledger_link');
  const {issue_key,pmid}=value;
  requireThat(issue_key!==undefined||pmid!==undefined,'invalid_ledger_link');
  if(issue_key!==undefined){requireThat(typeof issue_key==='string'&&issue_key.length<=2000,'invalid_ledger_link');validKey(issue_key);}
  if(pmid!==undefined)requireThat(typeof pmid==='string'&&/^[1-9][0-9]{0,8}$/.test(pmid),'invalid_pmid');
  return {...(issue_key!==undefined?{issue_key}:{}),...(pmid!==undefined?{pmid}:{})};
}

// A saved operation proves that its metadata revision was actually published.
// Ready-but-unpublished uploads must never become link targets.
const savedRevision=`SELECT o.id FROM issue_events e JOIN operations o ON o.id=e.operation_id
  WHERE e.issue_key=? AND json_extract(o.request_json,'$.revision')=?
  UNION ALL SELECT o.id FROM members m JOIN review_events e ON e.pmid=m.pmid JOIN operations o ON o.id=e.operation_id
  WHERE m.generation=? AND m.issue_key=? AND json_extract(o.request_json,'$.revision')=?`;
export async function linkedRevision(db,r){
  requireThat(/^[a-f0-9]{64}$/.test(r.revision??''),'invalid_link_revision');validKey(r.issue_key);
  const row=await db.prepare(`SELECT generation FROM settings WHERE id=1`).first();
  requireThat(row?.generation,'metadata_not_seeded',409);
  if(r.revision===row.generation)return false;
  const published=await db.prepare(`SELECT EXISTS(${savedRevision}) ok`).bind(r.issue_key,r.revision,r.revision,r.issue_key,r.revision).first();
  requireThat(published.ok,'linked_item_unavailable',404);
  return true;
}

export async function resolveLink(db,body){
  const r=linkTarget(body),key=r.issue_key??'',pmid=r.pmid??'';
  const membership=`(?='' OR EXISTS(SELECT 1 FROM members m WHERE m.generation=l.generation AND m.issue_key=l.issue_key AND m.pmid=?))`;
  let row=await db.prepare(`SELECT l.generation revision,l.issue_key FROM settings s JOIN issue_lists l ON l.generation=s.generation
    WHERE s.id=1 AND (?='' OR l.issue_key=?) AND ${membership}
    ORDER BY json_extract(l.info_json,'$.delivered_date') DESC,json_extract(l.info_json,'$.issue_id') DESC,l.issue_key LIMIT 1`)
    .bind(key,key,pmid,pmid).first();
  let read_only=false;
  if(!row){
    const events=key?`SELECT o.request_json,e.version FROM issue_events e JOIN operations o ON o.id=e.operation_id WHERE e.issue_key=?`:
      `SELECT o.request_json,e.version FROM review_events e JOIN operations o ON o.id=e.operation_id WHERE e.pmid=?`;
    row=await db.prepare(`WITH saved AS (${events}) SELECT l.generation revision,l.issue_key FROM saved e
      JOIN issue_lists l ON l.generation=json_extract(e.request_json,'$.revision')
      WHERE (?='' OR l.issue_key=?) AND ${membership}
      ORDER BY e.version DESC,json_extract(l.info_json,'$.delivered_date') DESC,l.issue_key LIMIT 1`)
      .bind(key||pmid,key,key,pmid,pmid).first();
    read_only=true;
  }
  requireThat(row,'linked_item_unavailable',404);
  return {...row,read_only,...(pmid?{pmid}:{})};
}
