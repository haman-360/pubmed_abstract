"""Google Sheets GET only. Never calls the existing production publisher."""
import json
from .recent_data import NAMES
from .sync_local import SyncError


def read_source(sheet_id, auth_json):
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
    for name in NAMES:
        count = by_name[name]['rowCount']
        if count > 100000: raise SyncError('source_above_read_limit')
        ranges.append(f"'{name}'!A1:{widths[name]}{count}")
    response = sheets.spreadsheets().values().batchGet(spreadsheetId=sheet_id,ranges=ranges,valueRenderOption='UNFORMATTED_VALUE').execute(num_retries=0)
    if len(json.dumps(response).encode()) > 20000000: raise SyncError('source_above_read_limit')
    if metadata() != before: raise SyncError('source_changed_during_read_try_next_run')
    return {name:part.get('values',[]) for name,part in zip(NAMES,response['valueRanges'])}
