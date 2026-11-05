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

MAX_BYTES = 1_900_000  # Per HTTP request, not the size of the complete dataset.
CHUNK_BYTES = 196608
ROW_BYTES = 180000
FORMAT = "LOCAL_D1_CHUNKS_V2"
DEFAULT_WRITE_BUDGET = 80_000  # Local rehearsal per run; not an account-wide daily quota guard.


class SyncError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class JsonSyncTransport:
    """Bounded metadata requests; subclasses validate the destination and credentials."""
    def __init__(self, base_url, headers, attempts):
        if not 1 <= attempts <= 3:
            raise SyncError("Invalid retry count")
        self.base_url = base_url.rstrip("/")
        self.headers = {"Content-Type": "application/json", **headers}
        self.attempts = attempts
        self.requests = 0
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def post(self, action, value):
        if action not in ("status", "begin", "chunk", "build", "finish", "read", "publish"):
            raise SyncError("Metadata sync action required")
        body = canonical(value).encode("utf-8")
        if len(body) > MAX_BYTES:
            raise SyncError("metadata_exceeds_local_sync_limit: chunked storage is required")
        for attempt in range(self.attempts):
            self.requests += 1
            req = Request(self.base_url + "/sync/" + action, data=body, method="POST", headers=self.headers)
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


class LocalTransport(JsonSyncTransport):
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
        super().__init__(base_url, {"Authorization": "Bearer local-synthetic-sync"}, attempts)


def check_fixture(value):
    names = {"Papers", "Appearances", "Texts", "Issues", "TextRows", "IssueCandidates", "IssueCandidateRows"}
    if value.get("synthetic") is not True or set(value.get("tables", {})) != names:
        raise SyncError("Synthetic metadata tables only; reviews are forbidden")
    chunk_plan(value["tables"])
    return from_tables(value["tables"])


def chunk_plan(tables):
    manifest = {"format": FORMAT, "tables": {}}
    chunks = []
    for name, table in tables.items():
        spec = {"header": table[0], "count": len(table) - 1, "chunks": []}
        manifest["tables"][name] = spec
        rows, size, offset = [], 2, 0
        def flush():
            nonlocal rows, size, offset
            if not rows:
                return
            spec["chunks"].append({"index": len(spec["chunks"]), "offset": offset, "count": len(rows),
                                   "bytes": len(canonical(rows).encode("utf-8")), "sha256": digest(rows)})
            chunks.append({"table_name": name, "index": len(spec["chunks"]) - 1, "rows": rows})
            offset += len(rows)
            rows, size = [], 2
        for row in table[1:]:
            length = len(canonical(row).encode("utf-8"))
            if length > ROW_BYTES:
                raise SyncError("metadata_row_too_large")
            if rows and size + length + 1 > CHUNK_BYTES:
                flush()
            rows.append(row)
            size += length + (1 if len(rows) > 1 else 0)
        flush()
    if len(canonical(manifest).encode("utf-8")) > CHUNK_BYTES:
        raise SyncError("manifest_too_large")
    return manifest, chunks


def fixture_stats(value):
    tables = value["tables"]
    manifest, chunks = chunk_plan(tables)
    stored = len(canonical(tables).encode("utf-8"))
    return {"papers": len(tables["Papers"]) - 1, "issues": len(tables["Issues"]) - 1,
            "appearances": len(tables["Appearances"]) - 1,
            "wire_bytes": len(canonical(value).encode("utf-8")), "metadata_json_bytes": stored,
            "chunks": len(chunks), "max_chunk_bytes": max((len(canonical(c["rows"]).encode("utf-8")) for c in chunks), default=0),
            "manifest_bytes": len(canonical(manifest).encode("utf-8")), "fits_current_sync": True,
            "exceeds_legacy_row_limit": stored + 128 > 2_000_000}


def chunk_writes(chunk):
    # Current schema: chunk + PK (2), record + PK + two lookup indexes (4).
    rows, name = chunk["rows"], chunk["table_name"]
    count = 2 + 4 * len(rows)
    if name in ("Papers", "Issues"):
        count += 2 * len(rows)
    if name == "Issues":
        count += 2 * sum(len(json.loads(row[4])) for row in rows)
    return count


def read_tables(current, transport):
    if current["tables"] is not None:
        return current["tables"]
    manifest = current["manifest"]
    if digest(manifest) != current["payload_hash"] or manifest.get("format") != FORMAT:
        raise SyncError("Invalid published manifest")
    tables = {}
    for name, spec in manifest["tables"].items():
        rows = [spec["header"]]
        for descriptor in spec["chunks"]:
            part = transport.post("read", {"generation": current["revision"], "table_name": name, "index": descriptor["index"]})["rows"]
            if len(part) != descriptor["count"] or digest(part) != descriptor["sha256"]:
                raise SyncError("Published chunk readback mismatch")
            rows.extend(part)
        if len(rows) - 1 != spec["count"]:
            raise SyncError("Published row count mismatch")
        tables[name] = rows
    return tables


def sync_metadata(incoming, transport, stop_after_stage=False, write_budget=DEFAULT_WRITE_BUDGET):
    if not isinstance(write_budget, int) or write_budget < 64:
        raise SyncError("write_budget_must_be_at_least_64")
    payload = check_fixture(incoming)
    initial_manifest, _ = chunk_plan(incoming["tables"])
    current = transport.post("status", {})
    expected = current["revision"]
    def result(changed):
        return {"changed": changed, "verified": True, "papers": len(payload["papers"]),
                "appearances": len(payload["appearances"]), "requests": transport.requests}
    if current.get("payload_hash") in (digest(initial_manifest), digest(incoming["tables"])):
        return result(False)
    if expected is not None:
        payload = merge_payload(from_tables(read_tables(current, transport)), payload)
    tables = to_tables(payload)
    generation = digest(payload)
    manifest, chunks = chunk_plan(tables)
    root_hash = digest(manifest)
    if current.get("payload_hash") == root_hash:
        return result(False)
    started = transport.post("begin", {"synthetic": True, "generation": generation, "manifest": manifest})
    if not isinstance(started.get("uploaded"), list):
        raise SyncError("local_server_requires_restart_for_budgeted_sync")
    uploaded = {(c["table_name"], c["chunk_index"]) for c in started["uploaded"]}
    used = 4  # Upper bound for inserting generation plus temporary guard writes.
    def paused(next_writes):
        return {"paused": True, "published": False, "reason": "local_write_budget",
                "estimated_writes": used, "next_writes": next_writes, "requests": transport.requests}
    for chunk in chunks:
        if (chunk["table_name"], chunk["index"]) in uploaded:
            continue
        cost = chunk_writes(chunk)
        if used + cost > write_budget:
            return paused(cost)
        transport.post("chunk", {"generation": generation, **chunk})
        used += cost
    finish_writes = 3 * manifest["tables"]["Issues"]["count"] + 5
    if used + finish_writes > write_budget:
        return paused(finish_writes)
    for offset in range(0, manifest["tables"]["Issues"]["count"], 5):
        transport.post("build", {"generation": generation, "offset": offset})
    transport.post("finish", {"generation": generation})
    if stop_after_stage:
        return {"staged": True, "published": False, "requests": transport.requests}
    transport.post("publish", {"generation": generation, "expected_revision": expected})
    verified = transport.post("status", {})
    if verified["revision"] != generation or verified["payload_hash"] != root_hash or digest(verified["manifest"]) != root_hash:
        raise SyncError("Published metadata could not be verified; reload before retry")
    return result(True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8787")
    parser.add_argument("--revised", action="store_true")
    parser.add_argument("--scale", action="store_true")
    parser.add_argument("--papers", type=int, default=5000)
    parser.add_argument("--issues", type=int, default=200)
    parser.add_argument("--stop-after-stage", action="store_true")
    parser.add_argument("--inspect", action="store_true", help="Only inspect synthetic size; no HTTP")
    parser.add_argument("--write-budget", type=int, default=DEFAULT_WRITE_BUDGET,
                        help="Estimated metadata writes per LOCAL run; does not enforce daily account usage")
    args = parser.parse_args()
    try:
        transport = LocalTransport(args.base_url)
        data = scale_fixture(args.papers, args.issues) if args.scale else fixture(args.revised)
        result = fixture_stats(data) if args.inspect else sync_metadata(data, transport, args.stop_after_stage, args.write_budget)
        print(json.dumps(result, ensure_ascii=False))
    except (SyncError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
