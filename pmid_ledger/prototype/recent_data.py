"""Read-only source selection for the TEST's rolling two-calendar-month copy."""
from __future__ import annotations
import calendar
import json
from datetime import datetime
from zoneinfo import ZoneInfo
from pmid_ledger.core import HEADERS, canonical, digest, from_tables, to_tables
from .sync_local import chunk_plan, chunk_writes, SyncError

NAMES = ['Papers', 'Appearances', 'Texts', 'Issues', 'IssueCandidates', 'Reviews', 'IssueReviews']
MAX_PAPERS, MAX_ISSUES, MAX_WRITES = 5000, 500, 30000


def window(now=None):
    date = (now or datetime.now(ZoneInfo('Asia/Tokyo'))).astimezone(ZoneInfo('Asia/Tokyo')).date()
    month = date.year * 12 + date.month - 3
    year, m = divmod(month, 12)
    start = date.replace(year=year, month=m+1, day=min(date.day, calendar.monthrange(year, m+1)[1]))
    return {'from': start.isoformat(), 'through': date.isoformat()}


def normalized(name, rows):
    headers = HEADERS[name]
    if not rows or rows[0] != headers:
        raise SyncError('unexpected_source_header_' + name)
    return [headers] + [[str(r[i]) if i < len(r) and r[i] is not None else '' for i in range(len(headers))] for r in rows[1:] if any(v != '' for v in r)]


def plan_recent(source, now=None, *, queue_state=None):
    source = {n: normalized(n, source[n]) for n in NAMES}
    span = window(now)
    issues = [r for r in source['Issues'][1:] if span['from'] <= r[3] <= span['through']]
    pending_queue = None
    if queue_state is not None:
        issues, pending_queue = select_pending(source, queue_state, now)
        span = {'from': '1900-01-01', 'through': span['through']}
    keys = {r[0] for r in issues}
    ids = {p for r in issues for p in json.loads(r[4])}
    saved = latest_reviews(source)
    if queue_state is not None:
        # Keep source wishes/notes without importing their completed issue bodies.
        ids.update(p for p,r in saved.items() if r[5] or r[3] in {'want_fulltext','fulltext_obtained','read'})
    if len(ids) > MAX_PAPERS or len(issues) > MAX_ISSUES or (queue_state is None and (not ids or not issues)):
        raise SyncError('recent_source_empty_or_above_safety_limit')
    apps = [r for r in source['Appearances'][1:] if canonical([r[2], r[3]]) in keys]
    tids = {r[9] for r in apps}
    selected = {n: [HEADERS[n]] for n in ['Papers','Appearances','Texts','Issues','IssueCandidates','TextRows','IssueCandidateRows']}
    selected.update(Papers=[HEADERS['Papers']]+[r for r in source['Papers'][1:] if r[0] in ids],
                    Appearances=[HEADERS['Appearances']]+apps,
                    Texts=[HEADERS['Texts']]+[r for r in source['Texts'][1:] if r[0] in tids],
                    Issues=[HEADERS['Issues']]+issues,
                    IssueCandidates=[HEADERS['IssueCandidates']]+[r for r in source['IssueCandidates'][1:] if r[0] in keys])
    tables = to_tables(from_tables(selected))
    if len(tables['Papers'])-1 != len(ids) or {r[0]:r[5] for r in issues} != {r[0]:r[5] for r in tables['Issues'][1:]}:
        raise SyncError('source_issue_membership_or_content_mismatch')
    manifest, chunks = chunk_plan(tables, chunk_bytes=32768)
    manifest.update(data_source='recent-copy', trial_window=span, source_hash=digest(tables))
    if pending_queue is not None: manifest['pending_queue'] = pending_queue
    generation = digest(manifest)
    reviews = {}
    for r in source['Reviews'][1:]:
        if r[1] in ids and int(r[2]) > int(reviews.get(r[1], ['', '', '0'])[2]): reviews[r[1]] = r
    seeds = []
    known = set(queue_state.get('reviews', [])) if queue_state is not None else set()
    for identifier,r in sorted(reviews.items()):
        if r[3] not in {'unreviewed','reviewed_no_fulltext','want_fulltext','fulltext_obtained','read'} or len(r[5].encode('utf-16-le'))//2 > 2000:
            raise SyncError('unsupported_source_review')
        if identifier not in known and (queue_state is None or r[3] != 'unreviewed' or r[5]):
            seeds.append({'pmid':identifier, 'status':r[3], 'note':r[5]})
    latest = {}
    for r in source['IssueReviews'][1:]:
        if r[1] in keys and int(r[2]) > int(latest.get(r[1], ['', '', '0'])[2]): latest[r[1]] = r
    if any(r[3] not in {'unreviewed','in_progress','completed'} for r in latest.values()):raise SyncError('unsupported_source_issue_state')
    content = {r[0]:r[5] for r in tables['Issues'][1:]}
    known_issues = {r['issue_key'] for r in queue_state.get('issues',[])} if queue_state is not None else set()
    issue_seeds = [{'issue_key':k, 'status':r[3], 'content_version':r[4]} for k,r in sorted(latest.items()) if k not in known_issues and r[4].rstrip('=') == content[k].rstrip('=')]
    cost = 4+sum(chunk_writes(c) for c in chunks)+3*len(issues)+5+40*len(seeds)+40*len(issue_seeds)
    if cost > MAX_WRITES:
        if queue_state is not None and len(issues) > 1:
            return plan_recent(source, now, queue_state={**queue_state, 'limit': max(1,len(issues)//2)})
        raise SyncError('recent_write_budget_exceeded')
    return {'format':'RECENT_SYNC_V1','generation':generation,'tables':tables,'manifest':manifest,
            'review_seeds':seeds,'issue_seeds':issue_seeds,'estimated_writes':cost}


def latest_reviews(source):
    result = {}
    for r in source['Reviews'][1:]:
        if int(r[2]) > int(result.get(r[1], ['', '', '0'])[2]): result[r[1]] = r
    return result


def select_pending(source, state, now=None):
    """Select whole unfinished deliveries, newest first, without a date cutoff.

    Local state overrides source state. A changed content version requeues a
    completed issue. Capacity limits defer older issues; they never mark them done.
    """
    reviews = latest_reviews(source)
    local = {r['issue_key']: r for r in state.get('issues', [])}
    original = {}
    for r in source['IssueReviews'][1:]:
        if int(r[2]) > int(original.get(r[1], ['', '', '0'])[2]): original[r[1]] = r
    pending = []
    through = window(now)['through']
    for r in source['Issues'][1:]:
        if r[3] and (r[3] < '1900-01-01' or r[3] > through): continue
        if r[0] in local:
            current = local[r[0]]
            done = current['status'] == 'completed' and current['content_version'].rstrip('=') == r[5].rstrip('=')
        else:
            old = original.get(r[0])
            done = bool(old and old[3] == 'completed' and old[4].rstrip('=') == r[5].rstrip('=') and
                        all(state.get('review_statuses',{}).get(p,reviews.get(p, ['', '', '', 'unreviewed'])[3]) != 'unreviewed' for p in json.loads(r[4])))
        if not done: pending.append(r)
    pending.sort(key=lambda r: (r[3],r[1],r[2],r[0]), reverse=True)
    chosen, ids = [], set()
    limit = min(state.get('limit', 100), 100)
    for r in pending:
        more = set(json.loads(r[4]))
        if len(chosen) >= limit or len(ids | more) > 1000: break
        chosen.append(r);ids.update(more)
    if pending and not chosen: raise SyncError('single_pending_issue_above_safety_limit')
    return chosen, {'policy':'unfinished-v1', 'deferred_issues':len(pending)-len(chosen)}
