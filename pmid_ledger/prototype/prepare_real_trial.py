"""Prepare a bounded, private copy from read-only Sheet ranges; no HTTP or source writes."""
import json
import os
from pathlib import Path
import uuid
from pmid_ledger.core import from_tables, to_tables, digest
from .sync_local import chunk_plan, chunk_writes

ROOT = Path(__file__).resolve().parents[2]
FOLDER = ROOT / 'ledger_private/real-trial'


def prepare(source):
    if source.get('format') != 'SOURCE_SHEET_TRIAL_V1':
        raise ValueError('source_format_required')
    payload = from_tables(source['tables'])
    tables = to_tables(payload)
    if not 1 <= len(tables['Papers']) - 1 <= 50 or not 1 <= len(tables['Issues']) - 1 <= 3:
        raise ValueError('small_trial_required')
    window = source['window']
    if any(not window['from'] <= row[3] <= window['through'] for row in tables['Issues'][1:]):
        raise ValueError('recent_issues_required')
    if {r[0]: r[5] for r in source['tables']['Issues'][1:]} != {r[0]: r[5] for r in tables['Issues'][1:]}:
        raise ValueError('complete_source_issues_required')
    manifest, chunks = chunk_plan(tables)
    manifest.update(data_source='real-copy', trial_window=window)
    generation = digest({'tables': tables, 'data_source': 'real-copy', 'trial_window': window})
    ids = {r[0] for r in tables['Papers'][1:]}
    latest = {}
    headers = source['reviews'][0]
    for row in source['reviews'][1:]:
        r = dict(zip(headers, row))
        if r['pmid'] not in ids:
            raise ValueError('unselected_review')
        if int(r['version']) > int(latest.get(r['pmid'], {}).get('version', 0)):
            latest[r['pmid']] = r
    changes = []
    for identifier, r in sorted(latest.items()):
        if r['status'] not in {'unreviewed', 'reviewed_no_fulltext', 'want_fulltext', 'fulltext_obtained', 'read'} or len(r.get('note', '')) > 2000:
            raise ValueError('unsupported_review')
        changes.append(dict(pmid=identifier, expected_version=0, status=r['status'], note=r.get('note', '')))
    issue_latest = {}
    for row in source['issue_reviews'][1:]:
        r = dict(zip(source['issue_reviews'][0], row))
        if int(r['version']) > int(issue_latest.get(r['issue_key'], {}).get('version', 0)):
            issue_latest[r['issue_key']] = r
    requests = []
    for row in tables['Issues'][1:]:
        r = issue_latest.get(row[0])
        if not r:
            continue
        if r['content_version'] != row[5] or r['status'] not in {'unreviewed', 'in_progress', 'completed'}:
            raise ValueError('source_issue_state_mismatch')
        requests.append(dict(operation_id=str(uuid.uuid4()), revision=generation, issue_key=row[0], expected_version=0, content_version=row[5], status=r['status']))
    writes = 4 + sum(chunk_writes(c) for c in chunks) + 3 * manifest['tables']['Issues']['count'] + 5
    # Conservative allowance for operation log/indexes/current state/trigger updates; not an account quota guarantee.
    writes += 30 * len(changes) + 40 * len(requests)
    if writes > 10000:
        raise ValueError('trial_write_budget_exceeded')
    return dict(format='REAL_COPY_TRIAL_V1', tables=tables, generation=generation, manifest=manifest,
                review_request=dict(operation_id=str(uuid.uuid4()), revision=generation, changes=changes),
                issue_requests=requests, estimated_writes=writes, source_sha256=digest(source))


def main():
    path = FOLDER / 'plan.json'
    if path.exists():
        raise SystemExit('既存planを保持しました。再生成は明示的な別試験として扱ってください。')
    source = json.loads((FOLDER / 'source.json').read_text())
    plan = prepare(source)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(plan, out, ensure_ascii=False)
    print(json.dumps(dict(prepared=True, papers=len(plan['tables']['Papers'])-1, issues=len(plan['tables']['Issues'])-1,
                          estimated_writes=plan['estimated_writes'], source_modified=False)))


if __name__ == '__main__':
    main()
