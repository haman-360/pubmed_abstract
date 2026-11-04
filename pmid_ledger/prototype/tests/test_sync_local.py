import unittest
from pmid_ledger.prototype.fixture import fixture, scale_fixture
from pmid_ledger.prototype.sync_local import LocalTransport, SyncError, check_fixture, fixture_stats, sync_metadata


class SyncLocalTests(unittest.TestCase):
    def test_only_literal_loopback_and_no_userinfo_or_extra_url_parts(self):
        LocalTransport("http://127.0.0.1:8787/")
        for url in ("https://127.0.0.1:8787", "http://localhost:8787", "http://example.com:8787",
                    "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:8787/path",
                    "http://secret@127.0.0.1:8787", "http://127.0.0.1:8787?x=y", "http://127.0.0.1:8787/#x"):
            with self.subTest(url=url), self.assertRaises(SyncError):
                LocalTransport(url)

    def test_sync_cannot_accept_human_reviews(self):
        data = fixture()
        data["tables"]["Reviews"] = [["forbidden"]]
        with self.assertRaises(SyncError):
            check_fixture(data)

    def test_5000_fixture_has_expected_relations_and_uses_bounded_chunks(self):
        stats = fixture_stats(scale_fixture())
        self.assertEqual((stats["papers"], stats["issues"], stats["appearances"]), (5000, 200, 10000))
        self.assertTrue(stats["fits_current_sync"])
        self.assertTrue(stats["exceeds_legacy_row_limit"])
        self.assertLessEqual(stats["max_chunk_bytes"], 196608)
        self.assertGreater(stats["chunks"], 7)

    def test_oversized_individual_row_is_rejected_before_any_http(self):
        class NoHTTP:
            def post(self, *args):
                raise AssertionError("HTTP must not be called")
        value = fixture()
        value["tables"]["Papers"][1][1] = "a" * 180001
        with self.assertRaisesRegex(SyncError, "metadata_row_too_large"):
            sync_metadata(value, NoHTTP())

    def test_current_supported_fixture_size(self):
        self.assertTrue(fixture_stats(scale_fixture(500, 20))["fits_current_sync"])
        self.assertEqual(len(check_fixture(fixture())["papers"]), 120)


if __name__ == "__main__":
    unittest.main()
