"""Synthetic metadata -> localhost only. No Drive, OAuth, AI or production workflow."""
from __future__ import annotations

import argparse
import json
import socket
import time
from http.client import IncompleteRead
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

from pmid_ledger.core import canonical, digest, from_tables, merge_payload, to_tables
from .fixture import fixture, scale_fixture

MAX_BYTES = 1_900_000  # D1 row limit is 2,000,000 bytes; keep room for IDs and hashes.


class SyncError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LocalTransport:
    def __init__(self, base_url, attempts=3):
        try:
            url = urlsplit(base_url)
            valid = (url.scheme == "http" and url.hostname == "127.0.0.1" and url.port is not None
                     and 1 <= url.port <= 65535 and not url.username and not url.password
                     and url.path in ("", "/") and not url.query and not url.fragment)
        except ValueError:
            valid = False
        if not valid:
            raise SyncError("Only http://127.0.0.1:<port> is allowed")
        if not 1 <= attempts <= 3:
            raise SyncError("Invalid retry count")
        self.base_url = base_url.rstrip("/")
        self.attempts = attempts
        self.requests = 0
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def post(self, action, value):
        if action not in ("status", "stage", "publish"):
            raise SyncError("Metadata sync action required")
        body = canonical(value).encode("utf-8")
        if len(body) > MAX_BYTES:
            raise SyncError("metadata_exceeds_local_sync_limit: chunked storage is required")
        for attempt in range(self.attempts):
            self.requests += 1
            req = Request(self.base_url + "/sync/" + action, data=body, method="POST", headers={
                "Content-Type": "application/json", "Authorization": "Bearer local-synthetic-sync"})
            retry = False
            try:
                with self.opener.open(req, timeout=10) as response:
                    raw = response.read(MAX_BYTES + 100_000)
                    if len(raw) > MAX_BYTES + 90_000:
                        raise SyncError("Sync response exceeds supported size")
                    result = json.loads(raw)
                if not isinstance(result, dict) or "value" not in result:
                    raise SyncError("Invalid sync response")
                return result["value"]
            except HTTPError as exc:
                retry = exc.code in (429, 500, 502, 503, 504)
                reason = "sync_http_" + str(exc.code)
                exc.close()
            except (URLError, TimeoutError, socket.timeout, ConnectionError, OSError, IncompleteRead):
                retry, reason = True, "sync_transport_result_unknown"
            except (ValueError, KeyError):
                raise SyncError("Invalid sync response") from None
            if not retry or attempt + 1 == self.attempts:
                raise SyncError(reason)
            time.sleep(0.05 * (attempt + 1))


def check_fixture(value):
    names = {"Papers", "Appearances", "Texts", "Issues", "TextRows", "IssueCandidates", "IssueCandidateRows"}
    if value.get("synthetic") is not True or set(value.get("tables", {})) != names:
        raise SyncError("Synthetic metadata tables only; reviews are forbidden")
    if len(canonical(value).encode("utf-8")) > MAX_BYTES:
        raise SyncError("metadata_exceeds_local_sync_limit: chunked storage is required")
    return from_tables(value["tables"])


def fixture_stats(value):
    tables = value["tables"]
    wire = len(canonical(value).encode("utf-8"))
    stored = len(canonical(tables).encode("utf-8"))
    return {"papers": len(tables["Papers"]) - 1, "issues": len(tables["Issues"]) - 1,
            "appearances": len(tables["Appearances"]) - 1, "wire_bytes": wire,
            "metadata_json_bytes": stored, "fits_current_sync": wire <= MAX_BYTES,
            "exceeds_d1_row_limit": stored + 128 > 2_000_000}


def sync_metadata(incoming, transport, stop_after_stage=False):
    payload = check_fixture(incoming)
    current = transport.post("status", {})
    expected = current["revision"]
    if current["tables"] is not None:
        payload = merge_payload(from_tables(current["tables"]), payload)
    tables = to_tables(payload)
    generation = digest(payload)
    value = dict(synthetic=True, generation=generation, tables=tables)
    check_fixture(value)  # Also cap the merged result before writing.
    table_hash = digest(tables)
    if current.get("payload_hash") == table_hash:
        return {"changed": False, "verified": True, "papers": len(payload["papers"]),
                "appearances": len(payload["appearances"]), "requests": transport.requests}
    transport.post("stage", value)
    if stop_after_stage:
        return {"staged": True, "published": False, "requests": transport.requests}
    # A timeout resends this same CAS request. A metadata conflict never adopts a new expected revision.
    transport.post("publish", {"generation": generation, "expected_revision": expected})
    verified = transport.post("status", {})
    if verified["revision"] != generation or digest(verified["tables"]) != table_hash:
        raise SyncError("Published metadata could not be verified; reload before retry")
    return {"changed": True, "verified": True, "papers": len(payload["papers"]),
            "appearances": len(payload["appearances"]), "requests": transport.requests}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8787")
    parser.add_argument("--revised", action="store_true")
    parser.add_argument("--scale", action="store_true")
    parser.add_argument("--papers", type=int, default=5000)
    parser.add_argument("--issues", type=int, default=200)
    parser.add_argument("--stop-after-stage", action="store_true")
    parser.add_argument("--inspect", action="store_true", help="Only inspect synthetic size; no HTTP")
    args = parser.parse_args()
    try:
        transport = LocalTransport(args.base_url)
        data = scale_fixture(args.papers, args.issues) if args.scale else fixture(args.revised)
        result = fixture_stats(data) if args.inspect else sync_metadata(data, transport, args.stop_after_stage)
        print(json.dumps(result, ensure_ascii=False))
    except (SyncError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
