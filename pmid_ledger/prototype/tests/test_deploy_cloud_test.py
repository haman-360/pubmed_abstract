import io
import json
import unittest
from email import policy
from email.parser import BytesParser
from urllib.error import HTTPError

from pmid_ledger.prototype.deploy_cloud_test import DeployError, downloaded_source, multipart, upload, validate, checked_bindings

RESOURCES = {"workerName": "pmid-ledger-test", "accountId": "a" * 32,
             "databaseId": "11111111-1111-4111-8111-111111111111",
             "origin": "https://pmid-ledger-test.synthetic.workers.dev"}
OWNER = {"projectId": "synthetic-ledger-auth", "ownerUid": "synthetic-owner"}
SOURCE = b"export default {}; // test_configuration_invalid\n"
TOKEN = "synthetic_worker_token_not_a_real_credential"
SYNC = {"accessIssuer": "https://synthetic.cloudflareaccess.com", "accessAudience": "b" * 64,
        "syncClientId": "synthetic-sync.access"}


class Reply(io.BytesIO):
    def __init__(self, body, mime):
        super().__init__(body)
        self.headers = {"Content-Type": mime}


class DeployTests(unittest.TestCase):
    def test_code_only_update_preserves_existing_bindings_without_transferring_identity(self):
        body, mime = multipart(RESOURCES, OWNER, SOURCE, SYNC)
        message = BytesParser(policy=policy.default).parsebytes(b"Content-Type: " + mime.encode() + b"\r\n\r\n" + body)
        bindings = json.loads(list(message.iter_parts())[0].get_payload(decode=True))["bindings"]
        bindings[-1].pop("text")
        settings = json.dumps({"success": True, "result": {"bindings": bindings}}).encode()
        class Opener:
            requests = []
            def open(self, request, timeout):
                self.requests.append(request)
                if request.full_url.endswith("/settings"):
                    return Reply(settings, "application/json")
                if request.method == "PUT":
                    message = BytesParser(policy=policy.default).parsebytes(b"Content-Type: " + request.get_header("Content-type").encode() + b"\r\n\r\n" + request.data)
                    metadata = json.loads(list(message.iter_parts())[0].get_payload(decode=True))
                    self.metadata = metadata
                    return Reply(b'{"success":true}', "application/json")
                return Reply(SOURCE, "application/javascript")
        opener = Opener()
        result = upload(RESOURCES, OWNER, SOURCE, TOKEN, opener, preserve_bindings=True)
        self.assertEqual([r.method for r in opener.requests], ["GET", "PUT", "GET", "GET"])
        self.assertNotIn("bindings", opener.metadata)
        self.assertEqual(opener.metadata["keep_bindings"], ["d1", "plain_text", "secret_text"])
        self.assertTrue(result["existing_bindings_preserved"])
        self.assertTrue(result["bindings_readback_verified"])
        self.assertNotIn(OWNER["ownerUid"], json.dumps(opener.metadata))
        for key, value in [("DB", {"name": "DB", "type": "d1", "id": "wrong"}),
                           ("LEDGER_SYNC_ENABLED", {"name": "LEDGER_SYNC_ENABLED", "type": "plain_text", "text": "0"})]:
            damaged = [value if b["name"] == key else b for b in bindings]
            with self.assertRaises(DeployError):
                checked_bindings(RESOURCES, json.dumps({"success": True, "result": {"bindings": damaged}}))

    def test_code_only_never_uploads_to_unverified_settings_and_refuses_changed_readback(self):
        body, mime = multipart(RESOURCES, OWNER, SOURCE, SYNC)
        message = BytesParser(policy=policy.default).parsebytes(b"Content-Type: " + mime.encode() + b"\r\n\r\n" + body)
        bindings = json.loads(list(message.iter_parts())[0].get_payload(decode=True))["bindings"]
        bindings[-1].pop("text")
        class Opener:
            def __init__(self, damage_before):
                self.requests = []
                self.damage_before = damage_before
            def open(self, request, timeout):
                self.requests.append(request)
                if request.full_url.endswith("/settings"):
                    entries = json.loads(json.dumps(bindings))
                    if self.damage_before or len(self.requests) > 1:
                        entries[0]["id"] = "wrong-database"
                    return Reply(json.dumps({"success": True, "result": {"bindings": entries}}).encode(), "application/json")
                return Reply(b'{"success":true}', "application/json") if request.method == "PUT" else Reply(SOURCE, "application/javascript")
        for before, count in [(True, 1), (False, 4)]:
            opener = Opener(before)
            with self.assertRaises(DeployError):
                upload(RESOURCES, OWNER, SOURCE, TOKEN, opener, preserve_bindings=True)
            self.assertEqual(len(opener.requests), count)

    def test_other_resources_incomplete_owner_and_mock_bundles_refused(self):
        for change in ({"workerName": "existing-app"}, {"accountId": ""}, {"databaseId": ""},
                       {"origin": RESOURCES["origin"] + "/path"}, {"origin": "http://127.0.0.1:8787"}):
            with self.assertRaises(DeployError):
                validate({**RESOURCES, **change}, OWNER, SOURCE)
        with self.assertRaises(DeployError):
            validate(RESOURCES, {**OWNER, "ownerUid": None}, SOURCE)
        for code in (b"", SOURCE + b"local-synthetic-owner", SOURCE + b"X-Local-Fault", SOURCE + b"LOCAL_PREVIEW_ONLY"):
            with self.assertRaises(DeployError):
                validate(RESOURCES, OWNER, code)

    def test_multipart_binds_only_test_db_and_fixed_owner_and_keeps_sync_disabled(self):
        body, mime = multipart(RESOURCES, OWNER, SOURCE)
        message = BytesParser(policy=policy.default).parsebytes(b"Content-Type: " + mime.encode() + b"\r\n\r\n" + body)
        parts = list(message.iter_parts())
        metadata = json.loads(parts[0].get_payload(decode=True))
        self.assertEqual(metadata["main_module"], "worker.mjs")
        bindings = {entry["name"]: entry for entry in metadata["bindings"]}
        self.assertEqual(bindings["DB"]["id"], RESOURCES["databaseId"])
        self.assertEqual(bindings["LEDGER_IDENTITY"]["type"], "secret_text")
        self.assertEqual(json.loads(bindings["LEDGER_IDENTITY"]["text"]), OWNER)
        self.assertEqual(bindings["LEDGER_SYNC_ENABLED"]["text"], "0")
        self.assertNotIn("limits", metadata)
        self.assertEqual(parts[1].get_payload(decode=True), SOURCE)
        self.assertNotIn(TOKEN.encode(), body)

    def test_upload_uses_exact_cloudflare_target_and_verifies_source_readback(self):
        class Opener:
            requests = []
            def open(self, request, timeout):
                self.requests.append(request)
                return Reply(b'{"success":true}', "application/json") if request.method == "PUT" else Reply(SOURCE, "application/javascript")
        opener = Opener()
        result = upload(RESOURCES, OWNER, SOURCE, TOKEN, opener)
        self.assertTrue(result["source_readback_verified"])
        self.assertFalse(result["metadata_sync_enabled"])
        self.assertEqual([r.method for r in opener.requests], ["PUT", "GET"])
        self.assertTrue(all(r.full_url == "https://api.cloudflare.com/client/v4/accounts/" + "a" * 32 + "/workers/scripts/pmid-ledger-test" for r in opener.requests))
        self.assertNotIn(TOKEN, json.dumps(result))

    def test_readback_mismatch_is_not_retried_or_reported_as_success(self):
        class Opener:
            requests = 0
            def open(self, request, timeout):
                self.requests += 1
                return Reply(b'{"success":true}', "application/json") if request.method == "PUT" else Reply(b"different", "application/javascript")
        opener = Opener()
        with self.assertRaisesRegex(DeployError, "readback_mismatch"):
            upload(RESOURCES, OWNER, SOURCE, TOKEN, opener)
        self.assertEqual(opener.requests, 2)

    def test_http_errors_never_repeat_or_expose_body_or_token(self):
        for status in (302, 401, 403, 429, 503):
            class Opener:
                requests = 0
                def open(self, request, timeout):
                    self.requests += 1
                    raise HTTPError(request.full_url, status, TOKEN, {}, io.BytesIO(TOKEN.encode()))
            opener = Opener()
            with self.assertRaises(DeployError) as error:
                upload(RESOURCES, OWNER, SOURCE, TOKEN, opener)
            self.assertEqual(str(error.exception), "cloudflare_http_" + str(status))
            self.assertEqual(opener.requests, 1)

    def test_multipart_download_selects_named_module_and_rejects_missing_module(self):
        body, mime = multipart(RESOURCES, OWNER, SOURCE)
        self.assertEqual(downloaded_source(body, mime), SOURCE)
        with self.assertRaises(DeployError):
            downloaded_source(body.replace(b"worker.mjs", b"other.mjs"), mime)

    def test_sync_is_opt_in_and_does_not_allow_client_secret_in_worker_identity(self):
        body, mime = multipart(RESOURCES, OWNER, SOURCE, SYNC)
        message = BytesParser(policy=policy.default).parsebytes(b"Content-Type: " + mime.encode() + b"\r\n\r\n" + body)
        metadata = json.loads(list(message.iter_parts())[0].get_payload(decode=True))
        bindings = {b["name"]: b for b in metadata["bindings"]}
        self.assertEqual(bindings["LEDGER_SYNC_ENABLED"]["text"], "1")
        self.assertEqual(json.loads(bindings["LEDGER_IDENTITY"]["text"]), {**OWNER, **SYNC})
        for change in ({"clientSecret": TOKEN}, {"accessIssuer": "https://evil.invalid"},
                       {"accessAudience": ""}, {"syncClientId": "bad\r\n.access"}):
            with self.assertRaises(DeployError):
                multipart(RESOURCES, OWNER, SOURCE, {**SYNC, **change})

    def test_sync_upload_requires_settings_readback_and_stops_on_binding_mismatch(self):
        class Opener:
            def __init__(self, mismatch=False):
                self.requests = []
                self.mismatch = mismatch
            def open(self, request, timeout):
                self.requests.append(request)
                if request.method == "PUT":
                    message = BytesParser(policy=policy.default).parsebytes(
                        b"Content-Type: " + request.get_header("Content-type").encode() + b"\r\n\r\n" + request.data)
                    self.metadata = json.loads(list(message.iter_parts())[0].get_payload(decode=True))
                    return Reply(b'{"success":true}', "application/json")
                if request.full_url.endswith("/settings"):
                    bindings = self.metadata["bindings"]
                    if self.mismatch:
                        bindings[0]["id"] = "wrong-database"
                    # The live API omits secret values.
                    bindings[-1].pop("text")
                    return Reply(json.dumps({"success": True, "result": {"bindings": bindings}}).encode(), "application/json")
                return Reply(SOURCE, "application/javascript")
        opener = Opener()
        result = upload(RESOURCES, OWNER, SOURCE, TOKEN, opener, sync_config=SYNC)
        self.assertTrue(result["bindings_readback_verified"])
        self.assertTrue(result["metadata_sync_enabled"])
        self.assertTrue(opener.requests[-1].full_url.endswith("/scripts/pmid-ledger-test/settings"))
        self.assertNotIn(TOKEN, json.dumps(result))
        opener = Opener(mismatch=True)
        with self.assertRaisesRegex(DeployError, "settings_readback_mismatch"):
            upload(RESOURCES, OWNER, SOURCE, TOKEN, opener, sync_config=SYNC)
        self.assertEqual(len(opener.requests), 3)


if __name__ == "__main__":
    unittest.main()
