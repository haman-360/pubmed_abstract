"""Configure only the TEST copy workflow; existing production settings remain untouched."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.request import Request,build_opener,ProxyHandler
from urllib.error import HTTPError
from .sync_local import NoRedirect,SyncError
ROOT=Path(__file__).resolve().parents[2]
REPO='haman-360/pubmed_abstract'
PREFIX='https://api.github.com/repos/'+REPO
WORKFLOW='pmid-ledger-test.yml'


def encryption():
    try:
        from nacl.public import PublicKey,SealedBox
    except ImportError:
        vendor=ROOT/'ledger_private/recent-sync/vendor'
        if not vendor.is_dir():raise SyncError('private_encryption_dependency_required')
        sys.path.insert(0,str(vendor))
        from nacl.public import PublicKey,SealedBox
    return PublicKey,SealedBox


class GitHub:
    def __init__(self):
        self.token=None
        try:
            response=subprocess.run(['git','credential','fill'],input='protocol=https\nhost=github.com\n\n',capture_output=True,text=True,timeout=15,cwd=ROOT,env={**os.environ,'GIT_TERMINAL_PROMPT':'0'})
            if response.returncode:raise ValueError()
            fields=dict(line.split('=',1) for line in response.stdout.splitlines() if '=' in line)
            self.token=fields.get('password')
            if not self.token:raise ValueError()
        except Exception:raise SyncError('existing_github_auth_unavailable') from None
        self.opener=build_opener(ProxyHandler({}),NoRedirect())
    def close(self):self.token=None
    def request(self,method,path,value=None,missing=False):
        if (path!='' and not path.startswith('/')) or '..' in path or '?' in path:raise SyncError('fixed_github_api_path_required')
        request=Request(PREFIX+path,method=method,data=json.dumps(value).encode() if value is not None else None,
                        headers={'Authorization':'Bearer '+self.token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json','User-Agent':'PMIDLedgerTest/1.0'})
        try:
            with self.opener.open(request,timeout=20) as r:
                raw=r.read(2000000)
                return json.loads(raw) if raw else {}
        except HTTPError as e:
            status=e.code;e.close()
            if missing and status==404:return None
            raise SyncError('github_test_setup_http_'+str(status)) from None
        except Exception as e:
            if isinstance(e,SyncError):raise
            raise SyncError('github_test_setup_result_unknown') from None


def preflight(api):
    if api.request('GET','').get('visibility')!='public':raise SyncError('public_standard_runner_required_for_zero_cost')
    # Use the already-existing production source secrets without retrieving their values.
    names={s['name'] for s in api.request('GET','/actions/secrets')['secrets']}
    if not {'GOOGLE_AUTHORIZED_USER_JSON','PMID_LEDGER_SHEET_ID'}<=names:raise SyncError('existing_google_source_secrets_required')
    file=api.request('GET','/contents/.github/workflows/'+WORKFLOW)
    local=(ROOT/'.github/workflows'/WORKFLOW).read_bytes()
    if base64.b64decode(file['content']) != local:raise SyncError('reviewed_main_test_workflow_required')
    if 'runs-on: ubuntu-latest' not in local.decode() or 'upload-artifact' in local.decode() or 'cache:' in local.decode():raise SyncError('standard_runner_without_artifacts_required')
    api.request('GET','/actions/secrets/public-key')
    return True


def configure(client_id,secret):
    PublicKey,SealedBox=encryption();api=GitHub()
    try:
        preflight(api)
        key=api.request('GET','/actions/secrets/public-key')
        box=SealedBox(PublicKey(base64.b64decode(key['key'])))
        for name,value in [('PMID_TEST_ACCESS_CLIENT_ID',client_id),('PMID_TEST_ACCESS_CLIENT_SECRET',secret)]:
            encrypted=base64.b64encode(box.encrypt(value.encode())).decode()
            api.request('PUT','/actions/secrets/'+name,{'encrypted_value':encrypted,'key_id':key['key_id']})
        path='/actions/variables/PMID_TEST_SYNC_ENABLED'
        exists=api.request('GET',path,missing=True)
        api.request('PATCH' if exists else 'POST',path if exists else '/actions/variables',{'name':'PMID_TEST_SYNC_ENABLED','value':'true'})
        api.request('POST','/actions/workflows/'+WORKFLOW+'/dispatches',{'ref':'main'})
        return True
    finally:api.close()
