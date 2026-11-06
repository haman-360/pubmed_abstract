"""Explicit synthetic TEST sync only. No real dataset, scheduler, login, or paid API."""
from __future__ import annotations

import argparse
import json
import os
import re

from .fixture import fixture
from .sync_local import JsonSyncTransport, SyncError, fixture_stats, sync_metadata


class CloudTestTransport(JsonSyncTransport):
    def __init__(self, base_url, client_id, client_secret):
        # An exact TEST origin only. No paths, ports, userinfo, queries, proxies or redirects.
        if not re.fullmatch(r"https://pmid-ledger-test\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev", base_url):
            raise SyncError("An exact pmid-ledger-test workers.dev HTTPS origin is required")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,240}\.access", client_id or ""):
            raise SyncError("A TEST Access Client ID is required")
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", client_secret or ""):
            raise SyncError("A TEST Access Client Secret is required")
        # Access exchanges these headers for a signed assertion at the edge.
        # No Bearer owner token or locally fabricated Access JWT is sent.
        # workers.dev rejects the default Python urllib signature (Cloudflare 1010).
        # Identify this approved TEST client without pretending to be a browser.
        super().__init__(base_url, {"CF-Access-Client-Id": client_id,
                                  "CF-Access-Client-Secret": client_secret,
                                  "User-Agent": "PMIDLedgerTest/1.0"}, attempts=1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inspect", action="store_true", help="Inspect 120 fictional papers without HTTP or credentials")
    parser.add_argument("--base-url", help="Exact separately approved TEST origin")
    parser.add_argument("--sync-synthetic", action="store_true", help="Upload only the built-in 120-paper fixture; default is read-only status")
    parser.add_argument("--write-budget", type=int, help="Explicit remaining budget verified in D1 console (64..80000)")
    args = parser.parse_args()
    try:
        data = fixture()
        if args.inspect:
            result = {"http": False, **fixture_stats(data)}
        else:
            if args.sync_synthetic and (args.write_budget is None or not 64 <= args.write_budget <= 80000):
                raise SyncError("Verify remaining D1 daily quota and set --write-budget 64..80000")
            transport = CloudTestTransport(args.base_url or "", os.environ.get("LEDGER_TEST_ACCESS_CLIENT_ID"),
                                           os.environ.get("LEDGER_TEST_ACCESS_CLIENT_SECRET"))
            if args.sync_synthetic:
                result = sync_metadata(data, transport, write_budget=args.write_budget)
            else:
                state = transport.post("status", {})
                result = {"published": state.get("revision") is not None, "requests": transport.requests, "writes_requested": False}
        print(json.dumps(result, ensure_ascii=False))
    except (SyncError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
