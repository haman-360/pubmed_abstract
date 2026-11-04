import {requireThat,validKey} from './metadata.mjs';
export const statuses = new Set(['unreviewed', 'reviewed_no_fulltext', 'want_fulltext', 'fulltext_obtained', 'read']);
export function operationRequest(body, kind) {
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
