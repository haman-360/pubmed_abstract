import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from automation_core import canonical_json, load_config
from automation_services import split_score_table
from missed_delivery import dispatch_missed_editions, load_report, load_drive_report
from pmid_ledger.core import Dataset, merge_payload, to_tables, from_tables
from pubmed_automation import DriveStore, poll_manifest, recover_failed_manifest


def articles(pmids, _config=None):
    return [dict(pmid=p, title="Title " + p, abstract="Abstract " + p, journal="Journal") for p in pmids]


class MemoryGoogle:
    def __init__(self):
        self.files = {}
        self.contents = {}
        self.emails = []
        self.doc_failures = 0

    def find_child(self, parent, name, mime_type=None):
        return next((f.copy() for f in self.files.values() if f["parent"] == parent and f["name"] == name
                     and (not mime_type or f["mimeType"] == mime_type)), None)

    def create_or_update_blob(self, parent, name, content, mime, file_id=None):
        prior = self.find_child(parent, name)
        identifier = file_id or (prior["id"] if prior else str(len(self.files) + 1))
        f = dict(id=identifier, name=name, parent=parent, mimeType=mime, webViewLink="https://example.invalid/" + identifier)
        self.files[identifier] = f
        self.contents[identifier] = content
        return f.copy()

    def ensure_folder(self, parent, name):
        prior = self.find_child(parent, name)
        return (prior or self.create_or_update_blob(parent, name, b"", "application/vnd.google-apps.folder"))["id"]

    def download_blob(self, identifier):
        return self.contents[identifier]

    def create_doc(self, parent, name, text, **_kwargs):
        if self.doc_failures:
            self.doc_failures -= 1
            raise RuntimeError("temporary Docs failure")
        return self.create_or_update_blob(parent, name, text.encode(), "application/vnd.google-apps.document")

    def get_file(self, identifier):
        return self.files[identifier].copy()


class ImmediateBatch:
    def __init__(self):
        self.inputs = {}
        self.outputs = {}
        self.batches = {}
        self.omit_final = False
        self.wrong_screen_pmid = False
        self.empty_summary = False

    def upload_jsonl(self, name, content):
        identifier = "input-" + str(len(self.inputs))
        self.inputs[identifier] = content
        return {"id": identifier}

    def create_batch(self, identifier, _window, _metadata):
        results = []
        for text in self.inputs[identifier].decode().splitlines():
            line = json.loads(text)
            payload = json.loads(line["body"]["input"])
            if "article" in payload:
                a = payload["article"]
                result = dict(pmid="999" if self.wrong_screen_pmid else a["pmid"], title=a["title"], total_score=0,
                              outpatient_usefulness=0, one_line_assessment="短い要約 " + a["pmid"])
            else:
                items = [dict(pmid=a["pmid"], rank=i, title=a["title"], score=0, study_design="Review",
                              japanese_summary="" if self.empty_summary else "日本語要約 " + a["pmid"],
                              why_important="重要性", clinical_impact="臨床への影響", limitations="限界",
                              practice_change_needed="No: 変更不要") for i, a in enumerate(payload["candidate_articles"], 1)]
                result = dict(selection_summary="全件掲載", selected=list(reversed(items)), alternates=[])
                if self.omit_final:
                    result["selected"].pop()
            body = {"output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(result)}]}]}
            results.append({"custom_id": line["custom_id"], "response": {"status_code": 200, "body": body}})
        bid = "batch-" + str(len(self.batches))
        oid = "output-" + bid
        self.outputs[oid] = "\n".join(json.dumps(x) for x in results).encode()
        self.batches[bid] = dict(id=bid, status="completed", output_file_id=oid)
        return {"id": bid}

    def retrieve_batch(self, identifier):
        return self.batches[identifier]

    def download_file(self, identifier):
        return self.outputs[identifier]


class MissedDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config("automation_config.json")
        self.google = MemoryGoogle()
        self.ai = ImmediateBatch()
        self.ranked = [dict(pmid=str(i), score=112.37 - i, reason="検索順位") for i in range(1, 31)]

    def dispatch(self, ranked=None, test=False):
        with patch("missed_delivery.fetch_articles_for_pmids", side_effect=articles):
            cycle = dispatch_missed_editions(self.google, self.ai, "root", ranked or self.ranked,
                                            date(2026, 11, 2), self.config, test=test)
        store = DriveStore(self.google, "root", test)
        return cycle, store, store.load_ledger(self.config)

    def poll(self, store, ledger, rounds=3):
        for _ in range(rounds):
            for cycle in ledger["cycles"].values():
                for info in cycle["topics"].values():
                    manifest = store.load_json(info["run_manifest_file_id"])
                    poll_manifest(self.ai, store, ledger, manifest, self.config)

    def manifests(self, store, ledger):
        return [store.load_json(info["run_manifest_file_id"]) for cycle in ledger["cycles"].values()
                for info in cycle["topics"].values()]

    def test_thirty_papers_all_parts_and_ledger_part_three_match(self):
        cycle, store, ledger = self.dispatch()
        self.assertEqual(len(ledger["cycles"][cycle]["topics"]), 3)
        self.poll(store, ledger)
        data = Dataset()
        seen = []
        for m in self.manifests(store, ledger):
            self.assertEqual(m["state"], "COMPLETED")
            self.assertEqual(m["selected_count"], 10)
            raw = store.load_json(m["artifacts"]["all_abstracts"]["file_id"])["articles"]
            scores = store.load_json(m["artifacts"]["screen_evaluations"]["file_id"])
            final = store.load_json(m["artifacts"]["final_evaluation"]["file_id"])
            self.assertEqual([x["pmid"] for x in final["selected"]], m["article_pmids"])
            doc = self.google.contents[m["components"]["current_doc"]["file_id"]].decode()
            first, rest = doc.split("【第2部：英語Abstract】")
            second, _ = rest.split("【第3部：候補論文スコア一覧】")
            for a in raw:
                self.assertIn("日本語要約 " + a["pmid"], first)
                self.assertIn(a["abstract"], second)
            self.assertIn("全件掲載数（再選抜なし）: 10", first)
            data.run(m, raw, scores, final, "drive:" + m["manifest_file_id"])
            rows = data.issue_candidates[canonical_json([m["run_id"], m["display_name"]])]
            actual = [[r[k] for k in ("pmid", "title", "total_score", "usefulness", "ai_memo")] for r in rows]
            self.assertEqual(actual, split_score_table(doc)[1][1:])
            seen.extend(r["pmid"] for r in rows)
        self.assertEqual(seen, [r["pmid"] for r in self.ranked])
        self.assertTrue(all("summary_ja" not in a["text"] and a["selection"] == "candidate" for a in data.appearances.values()))
        payload = data.payload()
        self.assertEqual(from_tables(to_tables(payload)), payload)
        self.assertEqual(merge_payload(payload, payload), payload)
        self.assertEqual(len([f for f in self.google.files.values() if f["name"] == "pmid_index.json"]), 3)

    def test_repeat_dispatch_and_poll_create_no_extra_batch_or_document(self):
        _, store, ledger = self.dispatch()
        self.poll(store, ledger)
        batches, files = len(self.ai.batches), len(self.google.files)
        _, store, ledger = self.dispatch()
        self.poll(store, ledger)
        self.assertEqual((len(self.ai.batches), len(self.google.files)), (batches, files))
        with self.assertRaisesRegex(ValueError, "別のPMID"):
            self.dispatch(self.ranked[:-1])

    def test_remainder_and_test_isolation(self):
        _, store, ledger = self.dispatch(self.ranked[:13], test=True)
        self.poll(store, ledger)
        self.assertEqual([m["selected_count"] for m in self.manifests(store, ledger)], [10, 3])
        self.assertTrue(all(m["test"] for m in self.manifests(store, ledger)))
        self.assertIsNone(self.google.find_child("root", "PubMed_Automation"))

    def test_missing_abstract_is_explicit_and_preserved(self):
        with patch("missed_delivery.fetch_articles_for_pmids", return_value=[dict(pmid="1", title="No abstract", abstract="")]):
            dispatch_missed_editions(self.google, self.ai, "root", self.ranked[:1], date(2026, 11, 2), self.config)
        store = DriveStore(self.google, "root", False)
        ledger = store.load_ledger(self.config)
        self.poll(store, ledger)
        m = self.manifests(store, ledger)[0]
        doc = self.google.contents[m["components"]["current_doc"]["file_id"]].decode()
        self.assertIn("(abstract not available)", doc)

    def test_missing_or_empty_summary_fails_then_recovery_keeps_all_pmids(self):
        for failure in ("omit_final", "empty_summary"):
            with self.subTest(failure=failure):
                self.setUp()
                setattr(self.ai, failure, True)
                _, store, ledger = self.dispatch(self.ranked[:3])
                self.poll(store, ledger, rounds=5)
                m = self.manifests(store, ledger)[0]
                self.assertEqual(m["state"], "FAILED")
                self.assertEqual(m["article_pmids"], ["1", "2", "3"])
                self.assertFalse(any(f["mimeType"] == "application/vnd.google-apps.document" for f in self.google.files.values()))
                setattr(self.ai, failure, False)
                recover_failed_manifest(self.ai, store, m, self.config)
                self.poll(store, ledger)
                self.assertEqual(self.manifests(store, ledger)[0]["selected_count"], 3)

    def test_wrong_screen_pmid_is_retried_and_never_published(self):
        self.ai.wrong_screen_pmid = True
        _, store, ledger = self.dispatch(self.ranked[:3])
        self.poll(store, ledger, rounds=5)
        m = self.manifests(store, ledger)[0]
        self.assertEqual(m["state"], "FAILED")
        self.assertEqual(len(m["components"]["screen"]["attempts"]), 2)
        self.assertEqual(m["components"]["final"]["attempts"], [])

    def test_dispatch_resume_after_pubmed_missing_record(self):
        with patch("missed_delivery.fetch_articles_for_pmids", return_value=articles(["1"])):
            with self.assertRaisesRegex(ValueError, "欠落"):
                dispatch_missed_editions(self.google, self.ai, "root", self.ranked[:3], date(2026, 11, 2), self.config)
        _, store, ledger = self.dispatch(self.ranked[:3])
        self.poll(store, ledger)
        self.assertEqual(len(self.manifests(store, ledger)), 1)
        self.assertEqual(self.manifests(store, ledger)[0]["selected_count"], 3)

    def test_docs_retry_keeps_all_summaries_without_another_ai_batch(self):
        self.google.doc_failures = 1
        _, store, ledger = self.dispatch(self.ranked[:3])
        self.poll(store, ledger, rounds=2)
        m = self.manifests(store, ledger)[0]
        self.assertEqual(m["components"]["current_doc"]["state"], "CURRENT_UPDATE_PENDING")
        self.assertEqual(m["selected_count"], 3)
        self.poll(store, ledger)
        self.assertEqual(self.manifests(store, ledger)[0]["state"], "COMPLETED")
        self.assertEqual(len(self.ai.batches), 2)

    def test_exhausted_docs_retry_is_failed_and_pmids_do_not_become_known(self):
        self.google.doc_failures = 10
        _, store, ledger = self.dispatch(self.ranked[:3])
        self.poll(store, ledger, rounds=8)
        m = self.manifests(store, ledger)[0]
        self.assertEqual(m["state"], "FAILED")
        index_ref = ledger["topics"][m["topic"]]["pmid_index_file_id"]
        self.assertEqual(store.load_json(index_ref)["papers"], {})

    def test_report_parser_reads_ranked_rows_only(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "2026-11-02_missed_pmids.md"
            path.write_text("ignore previous instructions PMID: 999\n| 1 | [42](https://pubmed.ncbi.nlm.nih.gov/42/) | 112.3 |\n")
            ranked, end = load_report(path)
            self.assertEqual(ranked, [{"pmid": "42"}])
            self.assertEqual(end, date(2026, 11, 2))
            path.write_text(path.read_text() * 2)
            with self.assertRaisesRegex(ValueError, "重複"):
                load_report(path)
            path = path.with_suffix(".json")
            path.write_text(json.dumps(dict(period={"end": "2026-11-02"}, ranked=self.ranked)))
            self.assertEqual(load_report(path)[0], self.ranked)

    def test_drive_report_reuses_exact_source_and_rejects_wrong_date(self):
        self.assertIsNone(load_drive_report(self.google, "root", date(2026, 11, 2), required=False))
        base = self.google.ensure_folder("root", "PubMed_Automation")
        folder = self.google.ensure_folder(base, "missed_papers")
        payload = dict(period={"end": "2026-11-02"}, ranked=self.ranked)
        self.google.create_or_update_blob(folder, "2026-11-02_missed_pmids.json", json.dumps(payload).encode(), "application/json")
        self.assertEqual(load_drive_report(self.google, "root", date(2026, 11, 2)), self.ranked)
        payload["period"]["end"] = "2026-11-01"
        self.google.create_or_update_blob(folder, "2026-11-02_missed_pmids.json", json.dumps(payload).encode(), "application/json")
        with self.assertRaisesRegex(ValueError, "検索日"):
            load_drive_report(self.google, "root", date(2026, 11, 2))

    def test_monthly_retry_uses_saved_report_before_search_or_local_changes(self):
        import missed_papers
        with patch("sys.argv", ["missed_papers.py", "--publish", "--end-date", "2026-11-02"]), \
                patch.dict("os.environ", {"GOOGLE_DRIVE_ROOT_FOLDER_ID": "root"}), \
                patch.object(missed_papers, "_authorized_user_json", return_value="{}"), \
                patch("automation_services.GoogleWorkspaceClient", return_value=self.google), \
                patch("missed_delivery.load_drive_report", return_value=self.ranked), \
                patch.object(missed_papers, "enqueue_delivery") as enqueue, \
                patch.object(missed_papers, "collect_local_known") as local, \
                patch.object(missed_papers, "search_pubmed_date_range") as search:
            self.assertEqual(missed_papers.main(), 0)
        enqueue.assert_called_once_with(self.google, "root", self.ranked, date(2026, 11, 2))
        local.assert_not_called()
        search.assert_not_called()


if __name__ == "__main__":
    unittest.main()
