import json
import unittest
import urllib.parse
from datetime import datetime, timezone
from unittest.mock import patch

import missed_papers
import pubmed_fetch


class PmidExtractionTests(unittest.TestCase):
    def test_default_date_uses_tokyo_timezone(self):
        utc_time = datetime(2026, 8, 8, 23, 30, tzinfo=timezone.utc)
        self.assertEqual(
            missed_papers.local_today(now=utc_time).isoformat(), "2026-08-09"
        )

    def test_extracts_only_explicit_pmid_forms(self):
        text = (
            "PMID: 12345678 / PMID：42 / https://pubmed.ncbi.nlm.nih.gov/11223344/ "
            '/ {"pmid": "55667788"} / year 20260809'
        )
        self.assertEqual(
            missed_papers.extract_pmids(text), {"12345678", "42", "11223344", "55667788"}
        )


class DateRangeSearchTests(unittest.TestCase):
    def test_control_character_json_is_accepted(self):
        raw = b'{"message":"line\x01break"}'
        with patch.object(pubmed_fetch, "fetch_url", return_value=raw), patch.object(
            pubmed_fetch.time, "sleep"
        ) as sleep:
            payload = pubmed_fetch.fetch_json("https://example.invalid")
        self.assertEqual(payload["message"], "line\x01break")
        sleep.assert_not_called()

    def test_truncated_json_is_retried(self):
        good = json.dumps({"esearchresult": {"count": "0", "idlist": []}}).encode()
        with patch.object(pubmed_fetch, "fetch_url", side_effect=[b'{"bad":', good]), patch.object(
            pubmed_fetch.time, "sleep"
        ) as sleep:
            payload = pubmed_fetch.fetch_json("https://example.invalid")
        self.assertEqual(payload["esearchresult"]["count"], "0")
        sleep.assert_called_once()

    def test_pdat_search_pages_and_uses_requested_date_field(self):
        seen = []

        def fake_fetch(url):
            seen.append(url)
            query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            start = int(query.get("retstart", ["0"])[0])
            ids = [str(i) for i in range(start, min(start + 2, 3))]
            return json.dumps({"esearchresult": {"count": "3", "idlist": ids}}).encode()

        with patch.object(pubmed_fetch, "fetch_url", side_effect=fake_fetch), patch.object(
            pubmed_fetch.time, "sleep"
        ):
            ids, total = pubmed_fetch.search_pubmed_date_range(
                "asthma", "2025-01-01", "2025-12-31", page_size=2
            )
        self.assertEqual(ids, ["0", "1", "2"])
        self.assertEqual(total, 3)
        self.assertIn("[pdat]", urllib.parse.unquote(seen[0]))

    def test_large_date_range_is_split_automatically(self):
        seen = []

        def fake_fetch(url):
            term = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["term"][0]
            seen.append(term)
            if "2025/01/01[pdat] : 2025/01/02[pdat]" in term:
                count, ids = "10001", []
            elif "2025/01/01[pdat] : 2025/01/01[pdat]" in term:
                count, ids = "1", ["1"]
            else:
                count, ids = "1", ["2"]
            return json.dumps({"esearchresult": {"count": count, "idlist": ids}}).encode()

        with patch.object(pubmed_fetch, "fetch_url", side_effect=fake_fetch), patch.object(
            pubmed_fetch.time, "sleep"
        ):
            ids, total = pubmed_fetch.search_pubmed_date_range(
                "pediatrics", "2025-01-01", "2025-01-02", max_records=10000
            )
        self.assertEqual(ids, ["1", "2"])
        self.assertEqual(total, 2)
        self.assertEqual(len(seen), 3)


class RankingTests(unittest.TestCase):
    def test_guideline_and_citations_both_contribute(self):
        result = missed_papers.rank_candidate(
            "12345678",
            {"asthma", "umbrella_signal"},
            {"12345678": {"citation_count": 8, "citations_per_year": 12, "nih_percentile": 90}},
            {"12345678": {"title": "Trial", "publication_types": ["Guideline"]}},
        )
        self.assertGreater(result["score"], 70)
        self.assertIn("引用8件", result["reason"])
        self.assertIn("Guideline", result["reason"])


if __name__ == "__main__":
    unittest.main()
