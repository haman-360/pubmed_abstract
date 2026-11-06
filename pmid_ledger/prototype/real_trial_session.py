"""Bounded real-data copy into the existing TEST; no source or production writes."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import sys
import warnings
from datetime import datetime, timezone
ROOT = Path(__file__).resolve().parents[2]
if __package__ in (None, ''):
    sys.path.insert(0, str(ROOT))

from pmid_ledger.core import digest
from pmid_ledger.prototype.sync_local import SyncError, chunk_plan, chunk_writes, read_tables
from pmid_ledger.prototype.sync_cloud_test import CloudTestTransport
from pmid_ledger.prototype.deploy_cloud_test import upload, validate, DeployError

ROOT = Path(__file__).resolve().parents[2]
FOLDER = ROOT / 'ledger_private/real-trial'


def private_json(path):
    if path.stat().st_mode & 0o077:
        raise SyncError('private_mode_required')
    return json.loads(path.read_text())


def execute(plan, receipt, transport, rollback=False):
    if plan.get('format') != 'REAL_COPY_TRIAL_V1' or plan['manifest'].get('data_source') != 'real-copy':
        raise SyncError('real_trial_plan_required')
    if receipt.get('verified') is not True or receipt.get('restore_readback_verified') is not True:
        raise SyncError('verified_backup_required')
    if plan['generation'] != digest(dict(tables=plan['tables'], data_source='real-copy', trial_window=plan['manifest']['trial_window'])):
        raise SyncError('trial_generation_hash_mismatch')
    snapshot = receipt['snapshot']
    current = transport.post('status', {})
    if rollback:
        if snapshot['active_revision'] != plan['generation'] or current['revision'] != plan['generation']:
            raise SyncError('fresh_real_trial_backup_required_for_rollback')
        target = plan.get('baseline_revision')
        if not target or target not in snapshot['generations']:
            raise SyncError('baseline_generation_missing')
        transport.post('publish', dict(generation=target, expected_revision=plan['generation'], backup_cutoff=snapshot['cutoff']))
        if transport.post('status', {})['revision'] != target:
            raise SyncError('rollback_readback_mismatch')
        return dict(rolled_back=True, verified=True, requests=transport.requests)
    generation, manifest = plan['generation'], plan['manifest']
    expected = snapshot['active_revision']
    if current['revision'] == generation:
        if current.get('payload_hash') != digest(manifest) or read_tables(current, transport) != plan['tables']:
            raise SyncError('trial_full_readback_mismatch')
        return dict(changed=False, verified=True, full_readback_verified=True, requests=transport.requests)
    if expected is None or current['revision'] != expected or current.get('manifest', {}).get('data_source') == 'real-copy':
        raise SyncError('backed_up_synthetic_baseline_required')
    baseline = read_tables(current, transport)
    for name in ('Papers', 'Issues'):
        if {r[0] for r in baseline[name][1:]} & {r[0] for r in plan['tables'][name][1:]}:
            raise SyncError('trial_identity_collision')
    generated, chunks = chunk_plan(plan['tables'])
    generated.update(data_source='real-copy', trial_window=manifest['trial_window'])
    if generated != manifest:
        raise SyncError('trial_manifest_mismatch')
    if 4 + sum(chunk_writes(c) for c in chunks) + 3 * manifest['tables']['Issues']['count'] + 5 > 10000:
        raise SyncError('trial_write_budget_exceeded')
    transport.post('begin', dict(real_copy=True, generation=generation, manifest=manifest))
    for chunk in chunks:
        transport.post('chunk', dict(generation=generation, **chunk))
    for offset in range(0, manifest['tables']['Issues']['count'], 5):
        transport.post('build', dict(generation=generation, offset=offset))
    transport.post('finish', dict(generation=generation))
    staged = dict(revision=generation, payload_hash=digest(manifest), manifest=manifest, tables=None)
    if read_tables(staged, transport) != plan['tables']:
        raise SyncError('trial_staged_readback_mismatch')
    transport.post('publish', dict(generation=generation, expected_revision=expected, backup_cutoff=snapshot['cutoff']))
    after = transport.post('status', {})
    if after['revision'] != generation or after['payload_hash'] != digest(manifest) or read_tables(after, transport) != plan['tables']:
        raise SyncError('trial_published_readback_mismatch')
    return dict(changed=True, verified=True, full_readback_verified=True, papers=len(plan['tables']['Papers'])-1,
                issues=len(plan['tables']['Issues'])-1, requests=transport.requests)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--update-and-publish', action='store_true', help='Preserve existing TEST bindings, update prepared code, then publish the backed-up copy')
    args = parser.parse_args()
    try:
        if sum((args.publish, args.rollback, args.update_and_publish)) != 1:
            raise SyncError('choose_one_trial_action')
        if args.update_and_publish:
            args.publish = True
        plan = private_json(FOLDER / 'plan.json')
        receipt = private_json(FOLDER / 'backup-receipt.json')
        archive = Path(receipt['file'])
        if archive.parent.resolve() != FOLDER.resolve() or archive.stat().st_mode & 0o077 or hashlib.sha256(archive.read_bytes()).hexdigest() != receipt['sha256']:
            raise SyncError('verified_private_backup_file_required')
        resources = private_json(ROOT / 'ledger_private/cloud-test-resources.json')
        if resources['workerName'] != 'pmid-ledger-test':
            raise SyncError('fixed_test_worker_required')
        deployment_path = ROOT / 'pmid_ledger/prototype/.cloud-test/deployment-verification.json'
        deployment = {} if args.update_and_publish else private_json(deployment_path)
        source = (ROOT / 'pmid_ledger/prototype/.cloud-test/worker.mjs').read_bytes()
        if not args.update_and_publish and (not all(deployment.get(k) is True for k in ('source_readback_verified', 'existing_bindings_preserved', 'bindings_readback_verified')) or deployment.get('sha256') != hashlib.sha256(source).hexdigest()):
            raise SyncError('verified_current_worker_required')
        if not sys.stdin.isatty():
            raise SyncError('interactive_terminal_required')
        if args.publish:
            existing = plan.get('baseline_revision')
            if existing and existing != receipt['snapshot']['active_revision']:
                raise SyncError('original_baseline_must_be_preserved')
            plan['baseline_revision'] = receipt['snapshot']['active_revision']
            plan.setdefault('baseline_backup', receipt)
            (FOLDER / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False))
        owner = private_json(ROOT / 'ledger_private/cloud-test-owner.json')
        validate(resources, owner, source)
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            worker_token = getpass.getpass('Worker更新用APIトークン（7日、非表示）: ') if args.update_and_publish else None
            client_id = getpass.getpass('同期用Client ID（末尾.access、非表示）: ')
            client_secret = getpass.getpass('同じ同期用Client Secret（非表示）: ')
        try:
            transport = CloudTestTransport(resources['origin'], client_id, client_secret)
            if args.update_and_publish:
                deployed = upload(resources, owner, source, worker_token, preserve_bindings=True)
                fd = os.open(deployment_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, 'w') as out:
                    json.dump(dict(**deployed, verified_at=datetime.now(timezone.utc).isoformat()), out)
            result = execute(plan, receipt, transport, rollback=args.rollback)
            result['worker_updated'] = args.update_and_publish
        finally:
            worker_token = client_id = client_secret = None
        path = FOLDER / ('rollback-verification.json' if args.rollback else 'sync-verification.json')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(dict(**result, verified_at=datetime.now(timezone.utc).isoformat()), out)
        print(json.dumps(result))
    except (DeployError, SyncError, OSError, ValueError, KeyError, getpass.GetPassWarning) as e:
        print(json.dumps(dict(error=str(e) if isinstance(e, (SyncError, DeployError)) else 'private_trial_settings_or_hidden_input_unavailable')))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
