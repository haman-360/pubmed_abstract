"""Google Sheets GET only. Never calls the existing production publisher."""
import json
from .recent_data import NAMES, normalized, select_pending
from pmid_ledger.core import HEADERS, canonical
from .sync_local import SyncError


def read_source(sheet_id, auth_json, *, queue_state=None):
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    credentials = Credentials.from_authorized_user_info(json.loads(auth_json), scopes=['https://www.googleapis.com/auth/drive.file'])
    drive = build('drive','v3',credentials=credentials,cache_discovery=False)
    sheets = build('sheets','v4',credentials=credentials,cache_discovery=False)
    def metadata():
        value = drive.files().get(fileId=sheet_id,fields='id,mimeType,version,appProperties,permissions(type,role)').execute(num_retries=0)
        if value.get('mimeType') != 'application/vnd.google-apps.spreadsheet' or value.get('appProperties',{}).get('pmidLedgerInstance') != 'pubmed-review-production-v1' or any(p['role']!='owner' for p in value.get('permissions',[])):
            raise SyncError('designated_owner_only_source_required')
        return value['version']
    before = metadata()
    properties = sheets.spreadsheets().get(spreadsheetId=sheet_id,fields='sheets.properties').execute(num_retries=0)
    by_name = {s['properties']['title']:s['properties']['gridProperties'] for s in properties['sheets']}
    ranges = []
    widths = {'Papers':'J','Appearances':'J','Texts':'C','Issues':'F','IssueCandidates':'I','Reviews':'H','IssueReviews':'G'}
    names = NAMES if queue_state is None else [n for n in NAMES if n != 'Texts'] + ['TextRows']
    widths['TextRows'] = 'C'
    for name in names:
        count = by_name[name]['rowCount']
        if count > 100000: raise SyncError('source_above_read_limit')
        ranges.append(f"'{name}'!A1:{widths[name]}{count}")
    response = sheets.spreadsheets().values().batchGet(spreadsheetId=sheet_id,ranges=ranges,valueRenderOption='UNFORMATTED_VALUE').execute(num_retries=0)
    if len(json.dumps(response).encode()) > 20000000: raise SyncError('source_above_read_limit')
    if len(response.get('valueRanges',[])) != len(names): raise SyncError('source_ranges_incomplete')
    source = {name:part.get('values',[]) for name,part in zip(names,response['valueRanges'])}
    if queue_state is not None:
        source = {n:normalized(n,rows) for n,rows in source.items()}
        chosen, _ = select_pending(source, queue_state)
        keys = {r[0] for r in chosen}
        tids = {r[9] for r in source['Appearances'][1:] if canonical([r[2],r[3]]) in keys}
        spans = []
        found = set()
        for tid,first,count in source['TextRows'][1:]:
            if tid not in tids: continue
            first,count = int(first),int(count)
            if tid in found or first < 2 or count < 1 or first+count-1 > by_name['Texts']['rowCount']:
                raise SyncError('source_text_index_invalid')
            found.add(tid);spans.append((first,first+count-1))
        if found != tids: raise SyncError('source_text_index_missing')
        merged = []
        for first,last in sorted(spans):
            if merged and first <= merged[-1][1]: raise SyncError('source_text_index_overlap')
            if merged and first == merged[-1][1]+1: merged[-1]=(merged[-1][0],last)
            else: merged.append((first,last))
        source['Texts'] = [HEADERS['Texts']]
        size = len(json.dumps(response).encode())
        for offset in range(0,len(merged),100):
            batch = merged[offset:offset+100]
            value = sheets.spreadsheets().values().batchGet(spreadsheetId=sheet_id,
                ranges=[f"'Texts'!A{a}:C{b}" for a,b in batch],valueRenderOption='UNFORMATTED_VALUE').execute(num_retries=0)
            size += len(json.dumps(value).encode())
            if size > 20000000: raise SyncError('source_above_read_limit')
            if len(value.get('valueRanges',[])) != len(batch): raise SyncError('source_ranges_incomplete')
            for (first,last),part in zip(batch,value['valueRanges']):
                rows = part.get('values',[])
                if len(rows) != last-first+1 or any(not row or row[0] not in tids for row in rows):
                    raise SyncError('source_text_index_mismatch')
                source['Texts'].extend(rows)
        del source['TextRows']
    if metadata() != before: raise SyncError('source_changed_during_read_try_next_run')
    return source
