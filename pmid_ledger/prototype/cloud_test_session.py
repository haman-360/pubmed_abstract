"""Hidden-input session for the existing synthetic TEST only; default is offline preparation."""
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, ProxyHandler

ROOT = Path(__file__).resolve().parents[2]
if __package__ in (None, ""):
    sys.path.insert(0, str(ROOT))

from pmid_ledger.core import digest
from pmid_ledger.prototype.deploy_cloud_test import DeployError, NoRedirect, upload, validate, validate_sync_config
from pmid_ledger.prototype.fixture import fixture
from pmid_ledger.prototype.sync_cloud_test import CloudTestTransport
from pmid_ledger.prototype.sync_local import SyncError, chunk_plan, chunk_writes, fixture_stats, read_tables, sync_metadata


def hidden_input(prompt):
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            return getpass.getpass(prompt)
        except getpass.GetPassWarning:
            raise DeployError("hidden_terminal_input_unavailable") from None


def load_local(root):
    private = root / "ledger_private"
    def read(name):
        path = private / name
        if path.stat().st_mode & 0o077:
            raise DeployError("private_settings_require_mode_0600")
        return json.loads(path.read_text())
    resources, owner, access = (read(name) for name in
                                ("cloud-test-resources.json", "cloud-test-owner.json", "cloud-test-access.json"))
    if set(access) != {"accessIssuer", "accessAudience"}:
        raise DeployError("invalid_local_access_settings")
    # Validate the saved public Access settings before asking for real credentials.
    validate_sync_config({**access, "syncClientId": "configuration-check.access"})
    source = (root / "pmid_ledger/prototype/.cloud-test/worker.mjs").read_bytes()
    validate(resources, owner, source)
    return resources, owner, access, source


def verify_routes(resources, opener=None):
    opener = opener or build_opener(ProxyHandler({}), NoRedirect())
    for path, owner_api in (("/api/listIssues", True), ("/sync/status", False), ("/", False), ("/api", False)):
        req = Request(resources["origin"] + path, data=b"{}", method="POST",
                      headers={"Content-Type": "application/json", "User-Agent": "PMIDLedgerTest/1.0"})
        try:
            try:
                response = opener.open(req, timeout=15)
            except HTTPError as exc:
                response = exc
            with response:
                raw = response.read(8193)
                is_json = "application/json" in response.headers.get("Content-Type", "")
                valid = response.code == 403 and len(raw) <= 8192 and raw.strip() != b"error code: 1010"
                if owner_api:
                    valid = valid and is_json and json.loads(raw) == {"error": "identity_denied"}
                else:
                    valid = valid and not is_json
                if not valid:
                    raise DeployError("test_access_path_separation_not_verified")
        except (URLError, TimeoutError, OSError, ValueError):
            raise DeployError("test_access_preflight_failed_no_automatic_retry") from None


def sync_fixture(transport, write_budget):
    data = fixture()
    manifest, _ = chunk_plan(data["tables"])
    hashes = {digest(manifest), digest(data["tables"])}
    state = transport.post("status", {})  # Real Access assertion must pass the Worker's signature policy.
    if state.get("revision") is not None and state.get("payload_hash") not in hashes:
        raise SyncError("unexpected_existing_test_metadata_stop")
    result = sync_metadata(data, transport, write_budget=write_budget)
    if result.get("paused"):
        return result
    state = transport.post("status", {})
    if read_tables(state, transport) != data["tables"]:
        raise SyncError("synthetic_full_readback_mismatch")
    return {**result, "full_readback_verified": True, "requests": transport.requests}


def write_report(root, name, result):
    path = root / "pmid_ledger/prototype/.cloud-test" / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump({**result, "verified_at": datetime.now(timezone.utc).isoformat()}, output)
    os.chmod(path, 0o600)


def main(root=ROOT):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enable-sync", action="store_true", help="Explicitly update only TEST and verify signed sync status")
    parser.add_argument("--sync-synthetic", action="store_true", help="Also transfer only the built-in 120 fictional papers")
    parser.add_argument("--write-budget", type=int, help="Confirmed remaining D1 write quota per run, 64..80000")
    args = parser.parse_args()
    try:
        if args.sync_synthetic and (not args.enable_sync or args.write_budget is None or not 64 <= args.write_budget <= 80000):
            raise DeployError("synthetic_sync_requires_enable_flag_and_verified_write_budget_64_80000")
        resources, owner, access, source = load_local(root)
        data = fixture()
        manifest, chunks = chunk_plan(data["tables"])
        if not args.enable_sync:
            result = {"prepared": True, "http": False, "source_sha256": hashlib.sha256(source).hexdigest(),
                      **fixture_stats(data), "estimated_initial_writes": 4 + sum(map(chunk_writes, chunks)) + 3 * manifest["tables"]["Issues"]["count"] + 5}
        else:
            if not sys.stdin.isatty():
                raise DeployError("interactive_terminal_required_for_credentials")
            verify_routes(resources)
            client_id = client_secret = api_token = transport = None
            try:
                client_id = hidden_input("既存の同期用Client ID（非表示）: ")
                client_secret = hidden_input("既存の同期用Client Secret（非表示・保存しません）: ")
                sync_config = {**access, "syncClientId": client_id}
                validate_sync_config(sync_config)
                transport = CloudTestTransport(resources["origin"], client_id, client_secret)
                api_token = hidden_input("TEST Worker更新用APIトークン（非表示・保存しません）: ")
                started = time.monotonic()
                # Invalidate an earlier successful session report before this attempt can mutate TEST.
                write_report(root, "sync-verification.json", {"phase": "started", "session_verified": False})
                deployment = upload(resources, owner, source, api_token, sync_config=sync_config)
                api_token = None
                write_report(root, "deployment-verification.json", deployment)
                if args.sync_synthetic:
                    result = sync_fixture(transport, args.write_budget)
                else:
                    state = transport.post("status", {})
                    result = {"published": state.get("revision") is not None, "writes_requested": False, "requests": transport.requests}
                result = {**result, "session_verified": True, "sync_enabled": True, "signed_access_verified": True,
                          "wall_seconds": round(time.monotonic() - started, 3)}
                verify_routes(resources)
                result["path_separation_verified_after_sync"] = True
                write_report(root, "sync-verification.json", result)
            finally:
                if transport is not None:
                    transport.headers.clear()
                client_id = client_secret = api_token = transport = None
        print(json.dumps(result, ensure_ascii=False))
    except (DeployError, SyncError, OSError, ValueError, TypeError, KeyError, EOFError, KeyboardInterrupt) as exc:
        # Config, HTTP bodies, credentials, and tracebacks must never be printed.
        safe = str(exc) if isinstance(exc, (DeployError, SyncError)) else "local_settings_or_session_unavailable"
        print(json.dumps({"error": safe}, ensure_ascii=False))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
