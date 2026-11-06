import io
import json
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest.mock import Mock, patch

from pmid_ledger.prototype import cloud_test_session as session
from pmid_ledger.prototype.deploy_cloud_test import DeployError
from pmid_ledger.prototype.fixture import fixture
from pmid_ledger.prototype.sync_local import SyncError
from pmid_ledger.prototype.tests.test_deploy_cloud_test import OWNER, RESOURCES, SOURCE, SYNC, TOKEN

SECRET = "synthetic_session_secret_not_a_real_credential"


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "ledger_private").mkdir()
        self.output = self.root / "pmid_ledger/prototype/.cloud-test"
        self.output.mkdir(parents=True)
        (self.output / "worker.mjs").write_bytes(SOURCE)
        for name, value in (("resources", RESOURCES), ("owner", OWNER),
                            ("access", {k: v for k, v in SYNC.items() if k != "syncClientId"})):
            path = self.root / ("ledger_private/cloud-test-" + name + ".json")
            path.write_text(json.dumps(value))
            path.chmod(0o600)

    def test_default_prepares_offline_and_never_prompts_or_requests_http(self):
        with patch("sys.argv", ["session"]), patch("sys.stdout", new_callable=io.StringIO) as output, \
                patch.object(session, "verify_routes", side_effect=AssertionError("No HTTP")), \
                patch.object(session.getpass, "getpass", side_effect=AssertionError("No credentials")):
            session.main(self.root)
        result = json.loads(output.getvalue())
        self.assertFalse(result["http"])
        self.assertEqual(result["papers"], 120)
        self.assertEqual(result["estimated_initial_writes"], 2167)

    def test_hidden_input_refuses_getpass_echo_fallback(self):
        def fallback(prompt):
            warnings.warn("Cannot disable echo", session.getpass.GetPassWarning)
            raise AssertionError("No visible credential input")
        with patch.object(session.getpass, "getpass", side_effect=fallback), \
                self.assertRaisesRegex(DeployError, "hidden_terminal_input_unavailable"):
            session.hidden_input("Synthetic credential: ")

    def test_transfer_requires_both_flags_and_bounded_budget_before_http_or_prompt(self):
        for flags in (("--sync-synthetic",), ("--enable-sync", "--sync-synthetic"),
                      ("--enable-sync", "--sync-synthetic", "--write-budget", "80001")):
            with self.subTest(flags=flags), patch("sys.argv", ["session", *flags]), \
                    patch("sys.stdout", new_callable=io.StringIO), patch.object(session, "load_local") as load, \
                    self.assertRaises(SystemExit):
                session.main(self.root)
            load.assert_not_called()

    def test_noninteractive_input_and_unsafe_private_mode_stop_before_http(self):
        with patch("sys.argv", ["session", "--enable-sync"]), patch("sys.stdin.isatty", return_value=False), \
                patch("sys.stdout", new_callable=io.StringIO) as output, patch.object(session, "verify_routes") as route, \
                self.assertRaises(SystemExit):
            session.main(self.root)
        route.assert_not_called()
        self.assertIn("interactive_terminal_required", output.getvalue())
        (self.root / "ledger_private/cloud-test-owner.json").chmod(0o644)
        with self.assertRaisesRegex(DeployError, "0600"):
            session.load_local(self.root)

    def test_route_preflight_requires_worker_denial_and_protected_other_paths(self):
        class Response(io.BytesIO):
            code = 403
            def __init__(self, raw, mime):
                super().__init__(raw)
                self.headers = {"Content-Type": mime}
        class Opener:
            def __init__(self, broken=False):
                self.requests = []
                self.broken = broken
            def open(self, req, timeout):
                self.requests.append(req)
                owner = req.full_url.endswith("/api/listIssues")
                if self.broken or owner:
                    return Response(b'{"error":"identity_denied"}', "application/json")
                return Response(b"Forbidden", "text/plain")
        opener = Opener()
        session.verify_routes(RESOURCES, opener)
        self.assertEqual(len(opener.requests), 4)
        with self.assertRaisesRegex(DeployError, "path_separation"):
            session.verify_routes(RESOURCES, Opener(broken=True))

    def test_unknown_existing_data_stops_before_sync_and_full_readback_is_required(self):
        transport = Mock()
        transport.post.return_value = {"revision": "unknown", "payload_hash": "unknown"}
        with patch.object(session, "sync_metadata") as sync, self.assertRaisesRegex(SyncError, "unexpected_existing"):
            session.sync_fixture(transport, 10000)
        sync.assert_not_called()
        transport.post.return_value = {"revision": None}
        with patch.object(session, "sync_metadata", return_value={"verified": True}), \
                patch.object(session, "read_tables", return_value={}), self.assertRaisesRegex(SyncError, "full_readback_mismatch"):
            session.sync_fixture(transport, 10000)
        with patch.object(session, "sync_metadata", return_value={"verified": True}), \
                patch.object(session, "read_tables", return_value=fixture()["tables"]):
            self.assertTrue(session.sync_fixture(transport, 10000)["full_readback_verified"])

    def test_paused_sync_does_not_claim_full_readback_or_request_it(self):
        transport = Mock()
        transport.post.return_value = {"revision": None}
        with patch.object(session, "sync_metadata", return_value={"paused": True}), patch.object(session, "read_tables") as read:
            self.assertEqual(session.sync_fixture(transport, 64), {"paused": True})
        read.assert_not_called()

    def test_hidden_session_stores_only_safe_results_and_clears_transport_credentials(self):
        transport = Mock(headers={"CF-Access-Client-Secret": SECRET}, requests=1)
        transport.post.return_value = {"revision": None, "sensitive_extra": SECRET}
        deployment = {"uploaded": True, "source_readback_verified": True, "bindings_readback_verified": True, "metadata_sync_enabled": True}
        with patch("sys.argv", ["session", "--enable-sync"]), patch("sys.stdin.isatty", return_value=True), \
                patch("sys.stdout", new_callable=io.StringIO) as output, patch.object(session, "verify_routes") as routes, \
                patch.object(session.getpass, "getpass", side_effect=[SYNC["syncClientId"], SECRET, TOKEN]), \
                patch.object(session, "CloudTestTransport", return_value=transport), patch.object(session, "upload", return_value=deployment) as upload:
            session.main(self.root)
        self.assertEqual(routes.call_count, 2)
        self.assertEqual(upload.call_args.kwargs["sync_config"], SYNC)
        self.assertEqual(transport.headers, {})
        self.assertFalse(json.loads(output.getvalue())["writes_requested"])
        for path in self.output.glob("*verification.json"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            for value in (SECRET, TOKEN, SYNC["syncClientId"], OWNER["ownerUid"]):
                self.assertNotIn(value, path.read_text() + output.getvalue())

    def test_failed_upload_never_syncs_and_does_not_print_credentials(self):
        transport = Mock(headers={"CF-Access-Client-Secret": SECRET})
        with patch("sys.argv", ["session", "--enable-sync", "--sync-synthetic", "--write-budget", "10000"]), \
                patch("sys.stdin.isatty", return_value=True), patch("sys.stdout", new_callable=io.StringIO) as output, \
                patch.object(session, "verify_routes"), patch.object(session.getpass, "getpass", side_effect=[SYNC["syncClientId"], SECRET, TOKEN]), \
                patch.object(session, "CloudTestTransport", return_value=transport), \
                patch.object(session, "upload", side_effect=DeployError("upload_completed_but_settings_readback_mismatch")), \
                patch.object(session, "sync_fixture") as sync, self.assertRaises(SystemExit):
            session.main(self.root)
        sync.assert_not_called()
        self.assertEqual(transport.headers, {})
        self.assertNotIn(SECRET, output.getvalue())
        self.assertFalse(json.loads((self.output / "sync-verification.json").read_text())["session_verified"])


if __name__ == "__main__":
    unittest.main()
