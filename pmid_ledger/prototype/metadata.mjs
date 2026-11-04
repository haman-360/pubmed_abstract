export const metadataNames = ['Papers', 'Appearances', 'Texts', 'Issues', 'TextRows', 'IssueCandidates', 'IssueCandidateRows'];
export function requireThat(ok, code, status = 400) {
  if (!ok) throw Object.assign(new Error(code), {status});
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function records(rows) {
  return rows.slice(1).map(row => Object.fromEntries(rows[0].map((key, i) => [key, row[i] ?? ''])));
}
export function validKey(key) {
  let parsed;
  try { parsed = JSON.parse(key); } catch { /* validated below */ }
  requireThat(Array.isArray(parsed) && parsed.length === 2 && parsed.every(x => typeof x === 'string' && x.length > 0), 'invalid_issue_key');
  requireThat(JSON.stringify(parsed) === key, 'noncanonical_issue_key');
}
// Body-free projections are built once at sync time, including Unicode case folding.
export function listProjection(t, raw) {
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
export function projectionStatements(db,g,t) {
  return records(t.Issues).map(raw => {
    const {info,items}=listProjection(t,raw);
    return db.prepare('INSERT OR IGNORE INTO issue_lists VALUES(?,?,?,?)').bind(g,raw.issue_key,JSON.stringify(info),JSON.stringify(items));
  });
}
