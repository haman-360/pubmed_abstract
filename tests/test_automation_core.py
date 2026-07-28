import json
import unittest
import urllib.parse
from datetime import date
from unittest.mock import patch

import pubmed_fetch
from automation_core import (
    assert_lightweight_ledger,
    choose_final_candidates,
    due_topic_names,
    final_batch_line,
    is_due,
    load_config,
    new_ledger,
    render_archive_doc,
    render_notebook_doc,
    screen_batch_lines,
    validate_final_result,
)


CONFIG_PATH = "automation_config.json"


def article(pmid):
    return {
        "pmid": str(pmid),
        "title": f"Title {pmid}",
        "abstract": f"SECRET ABSTRACT {pmid}",
        "journal": "Journal",
        "year": "2026",
        "month": "Jul",
        "author": "Author",
        "publication_types": ["Review"],
    }


def score(pmid, total, **kwargs):
    result = {
        "pmid": str(pmid),
        "title": f"Title {pmid}",
        "publication_type": "Review",
        "study_design": "Review",
        "estimated_sample_size": None,
        "is_guideline": False,
        "is_systematic_review": False,
        "is_meta_analysis": False,
        "is_rct": False,
        "is_large_study": False,
        "outpatient_usefulness": 3,
        "practice_change": 3,
        "evidence_strength": 3,
        "pediatric_directness": 3,
        "novelty": 3,
        "total_score": total,
        "one_line_assessment": "評価",
    }
    result.update(kwargs)
    return result


def final_item(pmid, rank):
    return {
        "rank": rank,
        "pmid": str(pmid),
        "title": f"Title {pmid}",
        "score": 20,
        "study_design": "RCT",
        "japanese_summary": "日本語要約",
        "why_important": "重要",
        "clinical_impact": "影響",
        "limitations": "限界",
        "practice_change_needed": "要検討",
    }


class ConfigAndScheduleTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config(CONFIG_PATH)

    def test_all_14_topics_have_unique_mapping_and_expected_frequency_counts(self):
        self.assertEqual(len(self.config["topics"]), 14)
        counts = {}
        for topic in self.config["topics"].values():
            counts[topic["frequency"]] = counts.get(topic["frequency"], 0) + 1
        self.assertEqual(counts, {"weekly": 4, "biweekly": 7, "monthly": 3})

    def test_biweekly_anchor_and_first_saturday(self):
        anchor = date(2026, 8, 1)
        self.assertTrue(is_due("biweekly", anchor, anchor))
        self.assertFalse(is_due("biweekly", date(2026, 8, 8), anchor))
        self.assertTrue(is_due("biweekly", date(2026, 8, 15), anchor))
        self.assertTrue(is_due("monthly", date(2026, 8, 1), anchor))
        self.assertFalse(is_due("monthly", date(2026, 8, 8), anchor))
        self.assertEqual(len(due_topic_names(self.config, anchor)), 14)


class PubMedPagingTests(unittest.TestCase):
    def test_edat_search_pages_beyond_100_and_removes_relative_dp(self):
        seen_urls = []

        def fake_fetch(url):
            seen_urls.append(url)
            query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            start = int(query.get("retstart", ["0"])[0])
            ids = [str(i) for i in range(start, min(start + 100, 230))]
            return json.dumps({"esearchresult": {"count": "230", "idlist": ids}}).encode()

        with patch.object(pubmed_fetch, "fetch_url", side_effect=fake_fetch), patch.object(
            pubmed_fetch.time, "sleep"
        ):
            ids, total = pubmed_fetch.search_pubmed_edat(
                'asthma AND ("last 30 days"[dp])', "2026-07-01", "2026-07-28", page_size=100
            )
        self.assertEqual(total, 230)
        self.assertEqual(len(ids), 230)
        self.assertEqual(len(seen_urls), 3)
        decoded = urllib.parse.unquote(seen_urls[0])
        self.assertIn("[edat]", decoded)
        self.assertNotIn("last 30 days", decoded)


class BatchAndSelectionTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config(CONFIG_PATH)

    def test_screen_custom_ids_are_unique_and_one_request_per_article(self):
        lines = screen_batch_lines("run", [article(1), article(2)], self.config)
        self.assertEqual([line["custom_id"] for line in lines], ["run:screen:1", "run:screen:2"])
        self.assertTrue(all(line["url"] == "/v1/responses" for line in lines))

    def test_rescue_includes_important_paper_outside_top20_and_caps_at24(self):
        scores = [score(i, 100 - i) for i in range(1, 26)]
        scores[-1].update({"is_guideline": True, "evidence_strength": 5})
        chosen = choose_final_candidates(scores, self.config)
        self.assertIn("25", {item["pmid"] for item in chosen})
        self.assertLessEqual(len(chosen), 24)

    def test_vertical_five_all_become_final_candidates(self):
        scores = [score(i, 20 - i) for i in range(1, 6)]
        candidates = choose_final_candidates(scores, self.config)
        self.assertEqual(len(candidates), 5)
        line = final_batch_line("run", "小児腎臓", candidates, [article(i) for i in range(1, 6)], self.config)
        schema = line["body"]["text"]["format"]["schema"]
        self.assertEqual(schema["properties"]["selected"]["maxItems"], 5)
        self.assertEqual(schema["properties"]["alternates"]["maxItems"], 0)

    def test_selected_and_alternates_are_distinct_and_bounded(self):
        result = {
            "selection_summary": "summary",
            "selected": [final_item(i, i) for i in range(1, 11)],
            "alternates": [final_item(i, i) for i in range(11, 16)],
        }
        validate_final_result(result, {str(i) for i in range(1, 25)}, 10, 5)
        result["alternates"][0]["pmid"] = "1"
        with self.assertRaises(ValueError):
            validate_final_result(result, {str(i) for i in range(1, 25)}, 10, 5)

    def test_final_selection_may_return_fewer_than_the_maximum(self):
        result = {
            "selection_summary": "only one was worthwhile",
            "selected": [final_item(1, 1)],
            "alternates": [],
        }
        validate_final_result(result, {"1", "2", "3"}, 10, 5)


class DocumentAndLedgerTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config(CONFIG_PATH)
        self.articles = [article(i) for i in range(1, 4)]
        self.scores = [score(i, 20 - i) for i in range(1, 4)]
        self.final = {
            "selection_summary": "summary",
            "selected": [final_item(1, 1), final_item(2, 2)],
            "alternates": [final_item(3, 3)],
        }

    def test_notebook_excludes_abstract_and_alternates(self):
        text = render_notebook_doc("テーマ", "run", self.articles, self.final)
        self.assertNotIn("SECRET ABSTRACT", text)
        self.assertNotIn("Title 3", text)
        self.assertIn("Title 1", text)

    def test_archive_keeps_abstract_scores_and_alternate(self):
        text = render_archive_doc("テーマ", "run", self.articles, self.scores, self.final)
        self.assertIn("SECRET ABSTRACT 3", text)
        self.assertIn("[次点] Title 3", text)
        self.assertIn("total_score=", text)

    def test_ledger_is_lightweight(self):
        ledger = new_ledger(self.config)
        assert_lightweight_ledger(ledger)
        ledger["abstract"] = "not allowed"
        with self.assertRaises(ValueError):
            assert_lightweight_ledger(ledger)


if __name__ == "__main__":
    unittest.main()
