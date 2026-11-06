import io
import json
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

from pmid_ledger.prototype.sync_cloud_test import CloudTestTransport, main
from pmid_ledger.prototype.sync_local import SyncError

ORIGIN = "https://pmid-ledger-test.synthetic.workers.dev"
CLIENT_ID = "synthetic-sync.access"
CLIENT_SECRET = "synthetic_secret_for_tests_only_1234567890"


class CloudTransportTests(unittest.TestCase):
    def test_exact_test_origin_and_header_validation(self):
        CloudTestTransport(ORIGIN, CLIENT_ID, CLIENT_SECRET)
        for url in ("http://pmid-ledger-test.synthetic.workers.dev", ORIGIN + "/", ORIGIN + "/sync",
                    ORIGIN + "?token=x", ORIGIN + "#x", ORIGIN + ":443", ORIGIN + ".evil.invalid",
                    "https://existing-pages.synthetic.workers.dev", "https://user@pmid-ledger-test.synthetic.workers.dev"):
            with self.subTest(url=url), self.assertRaises(SyncError):
                CloudTestTransport(url, CLIENT_ID, CLIENT_SECRET)
        for ident, secret in ((None, CLIENT_SECRET), (CLIENT_ID, None), (CLIENT_ID, "short"),
                              (CLIENT_ID, CLIENT_SECRET + "\r\n"), (CLIENT_ID + "\n", CLIENT_SECRET)):
            with self.assertRaises(SyncError):
                CloudTestTransport(ORIGIN, ident, secret)

    def test_cloud_headers_and_action_allowlist(self):
        transport = CloudTestTransport(ORIGIN, CLIENT_ID, CLIENT_SECRET)
        class Opener:
            def open(self, req, timeout):
                self.request = req
                return io.BytesIO(json.dumps({"value": {"revision": None}}).encode())
        opener = transport.opener = Opener()
        self.assertEqual(transport.post("status", {}), {"revision": None})
        headers = {k.lower(): v for k, v in opener.request.header_items()}
        self.assertEqual(headers["cf-access-client-id"], CLIENT_ID)
        self.assertEqual(headers["cf-access-client-secret"], CLIENT_SECRET)
        self.assertNotIn("authorization", headers)
        self.assertNotIn("cf-access-jwt-assertion", headers)
        self.assertEqual(opener.request.full_url, ORIGIN + "/sync/status")
        with self.assertRaises(SyncError):
            transport.post("../api/saveReviews", {})
        self.assertEqual(transport.requests, 1)

    def test_redirect_limit_and_unknown_commit_results_never_retry_or_expose_response(self):
        for status in (302, 403, 409, 429, 503):
            transport = CloudTestTransport(ORIGIN, CLIENT_ID, CLIENT_SECRET)
            class Opener:
                def open(self, req, timeout):
                    raise HTTPError(req.full_url, status, CLIENT_SECRET, {"Location": "https://evil.invalid"}, io.BytesIO(CLIENT_SECRET.encode()))
            transport.opener = Opener()
            with self.subTest(status=status), self.assertRaisesRegex(SyncError, "^sync_http_" + str(status) + "$"):
                transport.post("publish", {})
            self.assertEqual(transport.requests, 1)
        self.assertTrue(any(type(handler).__name__ == "NoRedirect" for handler in CloudTestTransport(ORIGIN, CLIENT_ID, CLIENT_SECRET).opener.handlers))

    def test_workers_dev_request_does_not_use_blocked_default_urllib_signature(self):
        transport = CloudTestTransport(ORIGIN, CLIENT_ID, CLIENT_SECRET)
        class Opener:
            def open(self, req, timeout):
                agent = req.get_header("User-agent", "Python-urllib/3.9")
                if agent.startswith("Python-urllib/"):
                    raise HTTPError(req.full_url, 403, "Forbidden", {}, io.BytesIO(b"error code: 1010\n"))
                self.agent = agent
                return io.BytesIO(b'{"value":{"revision":null}}')
        opener = transport.opener = Opener()
        self.assertEqual(transport.post("status", {}), {"revision": None})
        self.assertIn("PMIDLedgerTest", opener.agent)
        self.assertNotIn(CLIENT_SECRET, opener.agent)
        self.assertEqual(transport.requests, 1)

    def test_http_diagnostics_distinguish_edge_and_worker_without_retaining_content(self):
        cases = [(b'{"error":"identity_denied"}', "application/json", "worker_identity_denied"),
                 (b'{"error":"test_configuration_invalid"}', "application/json", "worker_configuration_invalid"),
                 (b"error code: 1010\n", "text/plain", "cloudflare_1010"),
                 (b"<html>Forbidden" + CLIENT_SECRET.encode() * 1000, "text/html", "access_or_edge"),
                 (json.dumps({"unexpected": CLIENT_SECRET}).encode(), "application/json", "other_json")]
        for raw, mime, kind in cases:
            transport = CloudTestTransport(ORIGIN, CLIENT_ID, CLIENT_SECRET)
            class Opener:
                def open(self, req, timeout):
                    raise HTTPError(req.full_url, 403, CLIENT_SECRET, {"Content-Type": mime}, io.BytesIO(raw))
            transport.opener = Opener()
            with self.subTest(kind=kind), self.assertRaisesRegex(SyncError, "^sync_http_403$"):
                transport.post("status", {})
            self.assertEqual(transport.last_http_error, {"status": 403, "response_kind": kind, "action": "status"})
            self.assertNotIn(CLIENT_SECRET, json.dumps(transport.last_http_error))
            self.assertEqual(transport.requests, 1)

    def test_inspect_never_constructs_transport_or_reads_credentials(self):
        with patch("sys.argv", ["sync_cloud_test", "--inspect"]), patch("sys.stdout", new_callable=io.StringIO) as output, \
                patch("pmid_ledger.prototype.sync_cloud_test.CloudTestTransport", side_effect=AssertionError("No HTTP")):
            main()
        result = json.loads(output.getvalue())
        self.assertFalse(result["http"])
        self.assertEqual(result["papers"], 120)

    def test_upload_requires_explicit_verified_write_budget_before_transport(self):
        for budget in ([], ["--write-budget", "0"], ["--write-budget", "80001"]):
            with patch("sys.argv", ["sync_cloud_test", "--sync-synthetic", *budget]), \
                    patch("sys.stdout", new_callable=io.StringIO) as output, \
                    patch("pmid_ledger.prototype.sync_cloud_test.CloudTestTransport", side_effect=AssertionError("No HTTP")), self.assertRaises(SystemExit):
                main()
            self.assertIn("Verify remaining D1 daily quota", json.loads(output.getvalue())["error"])

    def test_default_cli_requests_readonly_status_without_printing_payload(self):
        with patch("sys.argv", ["sync_cloud_test", "--base-url", ORIGIN]), patch("sys.stdout", new_callable=io.StringIO) as output, \
                patch("pmid_ledger.prototype.sync_cloud_test.CloudTestTransport") as factory:
            factory.return_value.requests = 1
            factory.return_value.post.return_value = {"revision": "synthetic", "tables": CLIENT_SECRET}
            main()
        factory.return_value.post.assert_called_once_with("status", {})
        result = json.loads(output.getvalue())
        self.assertEqual(result, {"published": True, "requests": 1, "writes_requested": False})
        self.assertNotIn(CLIENT_SECRET, output.getvalue())


if __name__ == "__main__":
    unittest.main()
