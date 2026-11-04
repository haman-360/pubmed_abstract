// Local experiment only. No production authentication or external service calls.
const statuses = new Set(['unreviewed', 'reviewed_no_fulltext', 'want_fulltext', 'fulltext_obtained', 'read']);
const metadataNames = ['Papers', 'Appearances', 'Texts', 'Issues', 'TextRows', 'IssueCandidates', 'IssueCandidateRows'];
const defaultReview = () => ({status: 'unreviewed', version: 0, note: '', status_updated_at: '', updated_at: ''});
function requireThat(ok, code, status = 400) {
  if (!ok) throw Object.assign(new Error(code), {status});
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function records(rows) {
  return rows.slice(1).map(row => Object.fromEntries(rows[0].map((key, i) => [key, row[i] ?? ''])));
}
function validKey(key) {
  let parsed;
  try { parsed = JSON.parse(key); } catch { /* validated below */ }
  requireThat(Array.isArray(parsed) && parsed.length === 2 && parsed.every(x => typeof x === 'string' && x.length > 0), 'invalid_issue_key');
  requireThat(JSON.stringify(parsed) === key, 'noncanonical_issue_key');
}
function operationRequest(body, kind) {
  const r = {kind, operation_id: body.operation_id, revision: body.revision, changes: body.changes ?? []};
  requireThat(/^[A-Za-z0-9-]{16,80}$/.test(r.operation_id ?? ''), 'invalid_operation_id');
  requireThat(typeof r.revision === 'string' && /^[a-f0-9]{64}$/.test(r.revision), 'invalid_revision');
  requireThat(Array.isArray(r.changes) && r.changes.length <= 100 && (kind !== 'reviews' || r.changes.length > 0), 'invalid_change_count');
  const ids = new Set();
  r.changes = r.changes.map(c => {
    requireThat(c && typeof c.pmid === 'string' && /^[1-9][0-9]{0,8}$/.test(c.pmid) && !ids.has(c.pmid), 'invalid_or_duplicate_pmid');
    ids.add(c.pmid);
    requireThat(statuses.has(c.status) && typeof c.note === 'string' && c.note.length <= 2000 && Number.isSafeInteger(c.expected_version) && c.expected_version >= 0, 'invalid_review');
    return {pmid: c.pmid, status: c.status, note: c.note, expected_version: c.expected_version};
  });
  if (body.issue_key !== undefined || kind !== 'reviews') {
    validKey(body.issue_key);
    r.issue_key = body.issue_key;
  }
  if (kind !== 'reviews') {
    requireThat(Number.isSafeInteger(body.expected_version) && body.expected_version >= 0 && typeof body.content_version === 'string', 'invalid_issue_version');
    r.expected_version = body.expected_version;
    r.content_version = body.content_version;
    r.status = kind === 'complete' ? 'completed' : body.status;
    requireThat(['unreviewed', 'in_progress', 'completed'].includes(r.status), 'invalid_issue_status');
  }
  if (kind === 'issue') requireThat(r.changes.length === 0, 'issue_changes_forbidden');
  if (kind === 'complete' && r.changes.length) {
    requireThat(/^[A-Za-z0-9-]{16,80}$/.test(body.review_operation_id ?? '') && body.review_operation_id !== r.operation_id, 'invalid_review_operation_id');
    r.review_operation_id = body.review_operation_id;
  } else requireThat(!body.review_operation_id, 'unexpected_review_operation_id');
  return r;
}

async function snapshot(db) {
  // One SQL statement reads metadata pointer and both current states consistently.
  const row = await db.prepare(`SELECT g.id AS revision,g.tables_json,
    (SELECT json_group_array(json_object('pmid',pmid,'version',version,'status',status,'note',note,
      'status_updated_at',status_updated_at,'updated_at',updated_at)) FROM review_current) AS reviews,
    (SELECT json_group_array(json_object('issue_key',issue_key,'version',version,'status',status,
      'content_version',content_version,'updated_at',updated_at)) FROM issue_current) AS issue_reviews
    FROM settings s JOIN generations g ON g.id=s.generation WHERE s.id=1`).first();
  requireThat(row, 'metadata_not_seeded', 409);
  return {revision: row.revision, tables: JSON.parse(row.tables_json),
    reviews: new Map(JSON.parse(row.reviews).map(({pmid, ...review}) => [pmid, review])),
    issueReviews: new Map(JSON.parse(row.issue_reviews).map(({issue_key, ...review}) => [issue_key, review]))};
}
function issues(s) {
  return records(s.tables.Issues).map(raw => {
    const r = s.issueReviews.get(raw.issue_key);
    const ids = JSON.parse(raw.pmids);
    const changed = !!r && r.status === 'completed' && r.content_version.replace(/=+$/, '') !== raw.content_version.replace(/=+$/, '');
    return {issue_key: raw.issue_key, issue_id: raw.issue_id, topic: raw.topic, delivered_date: raw.delivered_date,
      total: ids.length, unreviewed: ids.filter(id => (s.reviews.get(id)?.status ?? 'unreviewed') === 'unreviewed').length,
      status: changed ? 'in_progress' : r?.status ?? 'unreviewed', content_changed: changed,
      version: r?.version ?? 0, content_version: raw.content_version, updated_at: r?.updated_at ?? '', recovered: false};
  }).sort((a, b) => b.delivered_date.localeCompare(a.delivered_date) || b.issue_id.localeCompare(a.issue_id) || a.topic.localeCompare(b.topic));
}
function issue(s, key) {
  const found = issues(s).find(i => i.issue_key === key);
  requireThat(found, 'issue_missing', 404);
  return found;
}
function page(items, offset, size) {
  offset ??= 0;
  requireThat(Number.isSafeInteger(offset) && offset >= 0, 'invalid_offset');
  if (offset >= items.length) offset = Math.max(0, Math.floor((items.length - 1) / size) * size);
  return {items: items.slice(offset, offset + size), total: items.length, offset, page_size: size};
}
function issuePapers(s, r) {
  const selected = issue(s, r.issue_key);
  const apps = records(s.tables.Appearances).filter(a => JSON.stringify([a.issue_id, a.topic]) === r.issue_key);
  const members = new Set(apps.map(a => a.pmid));
  const candidates = records(s.tables.IssueCandidates).filter(c => c.issue_key === r.issue_key);
  const scored = candidates.length === members.size && candidates.every(c => members.has(c.pmid));
  const rows = scored ? candidates.sort((a, b) => Number(a.position) - Number(b.position))
    : records(s.tables.Papers).filter(p => members.has(p.pmid)).sort((a, b) => Number(a.pmid) - Number(b.pmid));
  const query = String(r.query ?? '').trim().toLowerCase();
  requireThat(query.length <= 300 && (!r.status || statuses.has(r.status)), 'invalid_filter');
  const items = rows.map(p => ({pmid: p.pmid, title: scored ? p.title : apps.find(a => a.pmid === p.pmid).title_at_delivery || p.title,
    review: s.reviews.get(p.pmid) ?? defaultReview(),
    score: scored ? {total: p.total_score, usefulness: p.usefulness, memo: p.ai_memo} : null}))
    .filter(p => (!query || p.pmid.includes(query) || p.title.toLowerCase().includes(query)) && (!r.status || p.review.status === r.status));
  return {...page(items, r.offset, 50), issue: selected, scores_available: scored, revision: s.revision};
}
async function stage(db, body) {
  requireThat(body.synthetic === true && /^[a-f0-9]{64}$/.test(body.generation ?? ''), 'synthetic_fixture_required');
  const t = body.tables;
  requireThat(t && Object.keys(t).length === metadataNames.length && metadataNames.every(n => Array.isArray(t[n]) && t[n].length > 0), 'metadata_tables_only');
  // This first stage only accepts the deterministic fixture schema, not production migration files.
  const headers = {Papers: ['pmid','title'], Appearances: ['snapshot_id','pmid','issue_id','topic'],
    Texts: ['text_id','part','body'], Issues: ['issue_key','issue_id','topic','delivered_date','pmids','content_version'],
    TextRows: ['text_id','first_row','row_count'], IssueCandidates: ['issue_key','pmid','snapshot_id','position','title'],
    IssueCandidateRows: ['issue_key','first_row','row_count']};
  for (const n of metadataNames) requireThat(headers[n].every((v, i) => t[n][0][i] === v) && t[n].every(row => Array.isArray(row) && row.length === t[n][0].length && row.every(v => typeof v === 'string')), 'invalid_metadata_schema');
  for (const i of records(t.Issues)) validKey(i.issue_key);
  const digest = await hash(t);
  const g = body.generation;
  await db.batch([
    db.prepare('INSERT INTO generations VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(g, digest, JSON.stringify(t)),
    db.prepare('INSERT INTO publish_guard SELECT CASE WHEN payload_hash=? THEN 1 ELSE 0 END FROM generations WHERE id=?').bind(digest, g),
    db.prepare(`INSERT OR IGNORE INTO papers SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)`).bind(g, JSON.stringify(t.Papers.slice(1))),
    db.prepare(`INSERT OR IGNORE INTO issues SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[5]') FROM json_each(?)`).bind(g, JSON.stringify(t.Issues.slice(1))),
    db.prepare(`INSERT OR IGNORE INTO members SELECT ?,json_extract(i.value,'$[0]'),p.value
      FROM json_each(?) i JOIN json_each(json_extract(i.value,'$[4]')) p`).bind(g, JSON.stringify(t.Issues.slice(1))),
    db.prepare('DELETE FROM publish_guard')
  ]);
  return {staged: true, generation: g};
}
async function publish(db, body) {
  requireThat(typeof body.generation === 'string' && (body.expected_revision === null || typeof body.expected_revision === 'string'), 'invalid_publish');
  await db.batch([
    db.prepare(`INSERT INTO publish_guard VALUES((SELECT CASE WHEN (generation IS ? OR generation=?) AND EXISTS(
      SELECT 1 FROM generations WHERE id=?) THEN 1 ELSE 0 END FROM settings WHERE id=1))`).bind(body.expected_revision, body.generation, body.generation),
    db.prepare('UPDATE settings SET generation=? WHERE id=1').bind(body.generation),
    db.prepare('DELETE FROM publish_guard')
  ]);
  return {published: true, revision: body.generation};
}
async function save(db, body, kind, fault) {
  const r = operationRequest(body, kind);
  const digest = await hash(r);
  const statements = [db.prepare('INSERT INTO operations VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
    .bind(r.operation_id, digest, JSON.stringify(r), new Date().toISOString())];
  if (fault === 'rollback') statements.push(db.prepare('INSERT INTO publish_guard VALUES(0)'));
  const result = await db.batch(statements);
  if (fault === 'drop-response') throw Object.assign(new Error('local_response_lost_retry_same_request'), {status: 503});
  const s = await snapshot(db);
  const current = r.issue_key ? issue(s, r.issue_key) : null;
  return {saved: true, replayed: result[0].meta.changes === 0, revision: s.revision,
    completion_recorded: kind === 'complete' || (kind === 'issue' && r.status === 'completed'),
    completed: (kind === 'complete' || r.status === 'completed') && current?.status === 'completed',
    reviews: r.changes.map(c => ({pmid: c.pmid, review: s.reviews.get(c.pmid) ?? defaultReview()})), issue: current};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'};
    try {
      requireThat(env.LOCAL_PROTOTYPE === '1' && ['127.0.0.1', 'localhost'].includes(url.hostname), 'local_only', 403);
      if (request.method === 'GET' && url.pathname === '/') return new Response(env.LOCAL_HTML, {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}});
      requireThat(request.method === 'POST', 'post_required', 405);
      const origin = request.headers.get('Origin');
      requireThat(!origin || origin === url.origin, 'origin_denied', 403);
      requireThat(request.headers.get('Content-Type')?.split(';')[0] === 'application/json', 'json_required', 415);
      const token = request.headers.get('Authorization');
      const syncing = url.pathname.startsWith('/sync/');
      requireThat(token === (syncing ? 'Bearer local-synthetic-sync' : 'Bearer local-synthetic-owner'), 'local_identity_denied', 403);
      const text = await request.text();
      requireThat(text.length <= 2000000, 'request_too_large', 413);
      const body = JSON.parse(text);
      let value;
      if (url.pathname === '/sync/stage') value = await stage(env.DB, body);
      else if (url.pathname === '/sync/publish') value = await publish(env.DB, body);
      else if (url.pathname === '/api/saveReviews') value = await save(env.DB, body, 'reviews', request.headers.get('X-Local-Fault'));
      else if (url.pathname === '/api/saveAndCompleteIssue') value = await save(env.DB, body, 'complete', request.headers.get('X-Local-Fault'));
      else if (url.pathname === '/api/saveIssueReview') value = await save(env.DB, body, 'issue', request.headers.get('X-Local-Fault'));
      else {
        const s = await snapshot(env.DB);
        if (url.pathname === '/api/listIssues') value = {...page(issues(s), body.offset, 20), revision: s.revision};
        else if (url.pathname === '/api/listIssuePapers') value = issuePapers(s, body);
        else if (url.pathname === '/api/getPaperDetail') {
          requireThat(/^[1-9][0-9]{0,8}$/.test(body.pmid ?? ''), 'invalid_pmid');
          const appearances = records(s.tables.Appearances).filter(a => a.pmid === body.pmid && (!body.issue_key || JSON.stringify([a.issue_id,a.topic]) === body.issue_key));
          requireThat(appearances.length, 'paper_missing', 404);
          value = {revision: s.revision, appearances: appearances.map(a => ({...a,
            text: JSON.parse(records(s.tables.Texts).filter(t => t.text_id === a.text_id).sort((x,y) => Number(x.part)-Number(y.part)).map(t => t.body).join(''))}))};
        } else throw Object.assign(new Error('unknown_endpoint'), {status: 404});
      }
      return new Response(JSON.stringify({value}), {headers});
    } catch (e) {
      const status = e.status ?? (/operation_id_reused|UNIQUE|conflict|remaining|CHECK|missing/.test(e.message) ? 409 : 400);
      return new Response(JSON.stringify({error: e.status ? e.message : status === 409 ? 'conflict_or_invalid_atomic_operation' : 'invalid_request_or_database_failure'}), {status, headers});
    }
  }
};
