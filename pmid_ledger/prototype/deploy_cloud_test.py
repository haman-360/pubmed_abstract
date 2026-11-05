"""Upload the approved TEST API only; prompts for a Worker-scoped token in a real terminal."""
from __future__ import annotations

import argparse
import email.policy
import getpass
import hashlib
import json
import re
import sys
import uuid
import os
from datetime import datetime, timezone
from email.parser import BytesParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[2]
MAX_BYTES = 2_000_000


class DeployError(Exception):
    pass


def validate(resources, owner, source):
    if resources.get("workerName") != "pmid-ledger-test" or not re.fullmatch(r"[a-f0-9]{32}", resources.get("accountId", "")):
        raise DeployError("invalid_test_resource_settings")
    if not re.fullmatch(r"https://pmid-ledger-test\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev", resources.get("origin", "")):
        raise DeployError("invalid_test_origin")
    try:
        if str(uuid.UUID(resources["databaseId"])) != resources["databaseId"]:
            raise ValueError()
    except (KeyError, ValueError, TypeError):
        raise DeployError("invalid_test_database") from None
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", owner.get("projectId", "")) or not isinstance(owner.get("ownerUid"), str) or not 1 <= len(owner["ownerUid"]) <= 128:
        raise DeployError("fixed_owner_required")
    if not 1 <= len(source) <= MAX_BYTES or b"test_configuration_invalid" not in source or any(x in source for x in (b"local-synthetic-owner", b"local-synthetic-sync", b"X-Local-Fault")):
        raise DeployError("cloud_test_bundle_required")


def multipart(resources, owner, source):
    validate(resources, owner, source)
    bindings = [{"name": "DB", "type": "d1", "id": resources["databaseId"]}]
    for name, value in {"LEDGER_TEST_ONLY": "synthetic", "LEDGER_ORIGIN": resources["origin"],
                        "LEDGER_SYNC_ENABLED": "0", "LEDGER_TEST_DIAGNOSTICS": "1"}.items():
        bindings.append({"name": name, "type": "plain_text", "text": value})
    bindings.append({"name": "LEDGER_IDENTITY", "type": "secret_text", "text": json.dumps(owner, separators=(",", ":"))})
    metadata = {"main_module": "worker.mjs", "compatibility_date": "2026-07-30", "bindings": bindings,
                "annotations": {"workers/message": "Authenticated synthetic ledger TEST API"}}
    boundary = "ledger-test-" + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'.encode()
            + json.dumps(metadata).encode()
            + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"\r\nContent-Type: application/javascript+module\r\n\r\n'.encode()
            + source + f'\r\n--{boundary}--\r\n'.encode())
    return body, "multipart/form-data; boundary=" + boundary


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def downloaded_source(raw, content_type):
    if content_type.lower().startswith("multipart/"):
        message = BytesParser(policy=email.policy.default).parsebytes(b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw)
        for part in message.iter_parts():
            if part.get_filename() == "worker.mjs" or part.get_param("name", header="content-disposition") == "worker.mjs":
                return part.get_payload(decode=True)
        raise DeployError("uploaded_module_missing_on_readback")
    return raw


def upload(resources, owner, source, token, opener=None):
    body, content_type = multipart(resources, owner, source)
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{20,512}", token):
        raise DeployError("invalid_worker_scoped_token")
    opener = opener or build_opener(ProxyHandler({}), NoRedirect())
    url = "https://api.cloudflare.com/client/v4/accounts/" + resources["accountId"] + "/workers/scripts/pmid-ledger-test"

    def request(method, data=None, mime=None):
        headers = {"Authorization": "Bearer " + token}
        if mime:
            headers["Content-Type"] = mime
        try:
            with opener.open(Request(url, data=data, method=method, headers=headers), timeout=30) as response:
                raw = response.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise DeployError("cloudflare_response_too_large")
                return raw, response.headers.get("Content-Type", "")
        except HTTPError as exc:
            status = exc.code
            exc.close()
            raise DeployError("cloudflare_http_" + str(status)) from None
        except (URLError, TimeoutError, OSError):
            raise DeployError("upload_or_readback_result_unknown_no_automatic_retry") from None

    raw, _ = request("PUT", body, content_type)
    try:
        if json.loads(raw).get("success") is not True:
            raise ValueError()
    except (ValueError, AttributeError):
        raise DeployError("upload_not_confirmed") from None
    raw, mime = request("GET")
    if downloaded_source(raw, mime) != source:
        raise DeployError("upload_completed_but_source_readback_mismatch")
    return {"uploaded": True, "source_readback_verified": True, "bytes": len(source),
            "sha256": hashlib.sha256(source).hexdigest(), "metadata_sync_enabled": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upload", action="store_true", help="Explicitly upload TEST code; otherwise prepare only without HTTP")
    args = parser.parse_args()
    try:
        resources = json.loads((ROOT / "ledger_private/cloud-test-resources.json").read_text())
        owner = json.loads((ROOT / "ledger_private/cloud-test-owner.json").read_text())
        source = (ROOT / "pmid_ledger/prototype/.cloud-test/worker.mjs").read_bytes()
        validate(resources, owner, source)
        if not args.upload:
            result = {"prepared": True, "http": False, "bytes": len(source), "sha256": hashlib.sha256(source).hexdigest()}
        else:
            if not sys.stdin.isatty():
                raise DeployError("interactive_terminal_required_for_token")
            token = getpass.getpass("TEST Worker専用のAPIトークン（非表示・保存しません）: ")
            try:
                result = upload(resources, owner, source, token)
            finally:
                token = None
            report = ROOT / "pmid_ledger/prototype/.cloud-test/deployment-verification.json"
            fd = os.open(report, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as output:
                json.dump({**result, "verified_at": datetime.now(timezone.utc).isoformat()}, output)
            os.chmod(report, 0o600)
        print(json.dumps(result, ensure_ascii=False))
    except (DeployError, OSError, ValueError) as error:
        # Never print response bodies, config contents, credentials, or a traceback.
        print(json.dumps({"error": str(error) if isinstance(error, DeployError) else "local_test_settings_or_bundle_unavailable"}, ensure_ascii=False))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
