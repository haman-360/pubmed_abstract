"""Read-only source -> existing TEST. Source states only initialize missing TEST state."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import getpass
import hashlib
import json
import os
from pathlib import Path
import sys
import warnings
ROOT = Path(__file__).resolve().parents[2]
if __package__ in (None, ''): sys.path.insert(0, str(ROOT))
from pmid_ledger.core import digest
from pmid_ledger.prototype.recent_data import MAX_WRITES, plan_recent
from pmid_ledger.prototype.recent_source import read_source
from pmid_ledger.prototype.sync_local import SyncError, chunk_plan, read_tables
from pmid_ledger.prototype.sync_cloud_test import CloudTestTransport
from pmid_ledger.prototype.deploy_cloud_test import DeployError, upload, validate
from pmid_ledger.prototype.real_trial_session import private_json

ORIGIN = 'https://pmid-ledger-test.tempter-carrel-5e.workers.dev'
FOLDER = ROOT / 'ledger_private/recent-sync'


def sync_recent(plan, transport, backup=None):
    manifest = plan['manifest']
    if plan.get('format') != 'RECENT_SYNC_V1' or manifest.get('data_source') != 'recent-copy' or manifest.get('source_hash') != digest(plan['tables']) or plan['generation'] != digest(manifest):
        raise SyncError('validated_recent_plan_required')
    if plan['estimated_writes'] > MAX_WRITES: raise SyncError('recent_write_budget_exceeded')
    current = transport.post('recentStatus', {})
    if current['stored_bytes'] + len(json.dumps(plan['tables'],ensure_ascii=False).encode()) > 64000000:
        raise SyncError('test_storage_safety_limit_stop_without_deleting_history')
    expected, generation = current['revision'], plan['generation']
    is_recent = current.get('manifest',{}).get('data_source') == 'recent-copy'
    unchanged = is_recent and current['manifest'].get('source_hash') == manifest['source_hash']
    if unchanged:
        if digest(current['manifest']) != current['payload_hash']: raise SyncError('current_manifest_hash_mismatch')
        generation = expected
    else:
        if not expected: raise SyncError('existing_backed_up_test_required')
        if not is_recent:
            if not backup or not backup.get('restore_readback_verified') or not backup.get('verified') or backup['snapshot']['active_revision'] != expected:
                raise SyncError('verified_current_backup_required')
        generated, chunks = chunk_plan(plan['tables'], chunk_bytes=32768)
        generated.update(data_source='recent-copy',trial_window=manifest['trial_window'],source_hash=manifest['source_hash'])
        if generated != manifest: raise SyncError('recent_manifest_mismatch')
        transport.post('begin',{'recent_copy':True,'generation':generation,'manifest':manifest})
        for c in chunks: transport.post('chunk',{'generation':generation,**c})
        for offset in range(0,manifest['tables']['Issues']['count'],5): transport.post('build',{'generation':generation,'offset':offset})
        transport.post('finish',{'generation':generation})
        staged={'revision':generation,'payload_hash':digest(manifest),'manifest':manifest,'tables':None}
        if read_tables(staged,transport) != plan['tables']: raise SyncError('recent_staged_readback_mismatch')
        publication={'generation':generation,'expected_revision':expected}
        if not is_recent: publication['backup_cutoff']=backup['snapshot']['cutoff']
        transport.post('publish',publication)
        after=transport.post('recentStatus',{})
        if after['revision'] != generation or after['payload_hash'] != digest(manifest) or read_tables({**after,'tables':None},transport) != plan['tables']:
            raise SyncError('recent_published_readback_mismatch')
    state_changed=False
    for action,key in [('seedReviews','review_seeds'),('seedIssues','issue_seeds')]:
        for offset in range(0,len(plan[key]),10):
            seeded=transport.post(action,{'revision':generation,'items':plan[key][offset:offset+10]})
            state_changed=state_changed or seeded.get('changed',False)
    final=transport.post('recentStatus',{})
    if final['revision'] != generation: raise SyncError('recent_sync_concurrent_publication')
    return {'changed':not unchanged or state_changed,'metadata_changed':not unchanged,'source_states_initialized':state_changed,'verified':True,'full_readback_verified':not unchanged,
            'papers':len(plan['tables']['Papers'])-1,'issues':len(plan['tables']['Issues'])-1,
            'appearances':len(plan['tables']['Appearances'])-1,'source_states_checked':len(plan['review_seeds']),
            'source_issue_states_checked':len(plan['issue_seeds']),'requests':transport.requests,'source_modified':False}


def write_report(path,value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as out:json.dump(value,out)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--update-and-sync',action='store_true')
    mode.add_argument('--sync',action='store_true')
    mode.add_argument('--scheduled',action='store_true')
    parser.add_argument('--configure-actions',action='store_true')
    args=parser.parse_args()
    try:
        if args.configure_actions:
            from pmid_ledger.prototype.recent_actions_setup import encryption,GitHub,preflight
            encryption();api=GitHub()
            try:preflight(api)
            finally:api.close()
        if args.scheduled:
            if args.configure_actions or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('GITHUB_REPOSITORY')!='haman-360/pubmed_abstract':
                raise SyncError('fixed_github_workflow_required')
            plan=plan_recent(read_source(os.environ['PMID_LEDGER_SHEET_ID'],os.environ['GOOGLE_AUTHORIZED_USER_JSON']))
            result=sync_recent(plan,CloudTestTransport(ORIGIN,os.environ['PMID_TEST_ACCESS_CLIENT_ID'],os.environ['PMID_TEST_ACCESS_CLIENT_SECRET']))
        else:
            if not sys.stdin.isatty():raise SyncError('hidden_interactive_input_required')
            resources=private_json(ROOT/'ledger_private/cloud-test-resources.json')
            owner=private_json(ROOT/'ledger_private/cloud-test-owner.json')
            source=(ROOT/'pmid_ledger/prototype/.cloud-test/worker.mjs').read_bytes()
            validate(resources,owner,source)
            if resources['origin']!=ORIGIN:raise SyncError('fixed_existing_test_required')
            raw=private_json(FOLDER/'source.json')
            plan=plan_recent({**raw['tables'],'Reviews':raw['reviews'],'IssueReviews':raw['issue_reviews']})
            backup=private_json(ROOT/'ledger_private/real-trial/backup-receipt.json')
            archive=Path(backup['file'])
            if archive.stat().st_mode&0o077 or hashlib.sha256(archive.read_bytes()).hexdigest()!=backup['sha256']:
                raise SyncError('verified_private_backup_required')
            if not args.update_and_sync:
                d=private_json(ROOT/'pmid_ledger/prototype/.cloud-test/deployment-verification.json')
                if d.get('sha256')!=hashlib.sha256(source).hexdigest() or not d.get('existing_bindings_preserved'):raise SyncError('verified_current_code_required')
            with warnings.catch_warnings():
                warnings.simplefilter('error',getpass.GetPassWarning)
                token=getpass.getpass('Worker更新用APIトークン（非表示）: ') if args.update_and_sync else None
                client_id=getpass.getpass('同期用Client ID（末尾.access、非表示）: ')
                secret=getpass.getpass('同じ同期用Client Secret（非表示）: ')
            try:
                transport=CloudTestTransport(ORIGIN,client_id,secret)
                if args.update_and_sync:
                    d=upload(resources,owner,source,token,preserve_bindings=True)
                    write_report(ROOT/'pmid_ledger/prototype/.cloud-test/deployment-verification.json',{**d,'verified_at':datetime.now(timezone.utc).isoformat()})
                result=sync_recent(plan,transport,backup)
                write_report(FOLDER/'sync-verification.json',{**result,'verified_at':datetime.now(timezone.utc).isoformat()})
                if args.configure_actions:
                    from pmid_ledger.prototype.recent_actions_setup import configure
                    result['actions_configured']=configure(client_id,secret)
            finally: token=client_id=secret=None
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'error':str(e) if isinstance(e,(SyncError,DeployError)) else 'recent_sync_stopped_no_source_writes_or_automatic_retry'}))
        raise SystemExit(1) from None


if __name__=='__main__':main()
