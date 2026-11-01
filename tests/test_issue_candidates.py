import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from candidate_scores import candidate_score_rows
from automation_core import render_notebook_doc
from automation_services import split_score_table
from pmid_ledger.core import Dataset, HEADERS, SCHEMA, canonical, from_tables, merge_payload, to_tables
from pmid_ledger.google_store import GoogleStore


class CandidateTests(unittest.TestCase):
    def dataset(self, issue="run-one", scores=None):
        articles = [{"pmid":"10","title":"Title | line\nnext 😀"}, {"pmid":"1","title":"Second"}, {"pmid":"2","title":"Missing"}]
        scores = scores if scores is not None else [
            {"pmid":"10","total_score":0,"outpatient_usefulness":0,"one_line_assessment":"zero\n| memo"},
            {"pmid":"1","total_score":21,"outpatient_usefulness":5,"one_line_assessment":"useful"}]
        d = Dataset()
        d.run({"run_id":issue,"topic":"topic","components":{"current_doc":{"state":"COMPLETED","file_id":"doc","completed_at":"2026-11-01T10:00:00Z"}}}, articles, scores, {"selected":[]}, "fixture")
        return d, articles, scores

    def test_docs_and_candidates_match_all_five_fields_and_order(self):
        d, articles, scores = self.dataset()
        text = render_notebook_doc("topic","run-one",articles,scores,{"selected":[]})
        _, rows = split_score_table(text)
        data = next(iter(d.payload()["issue_candidates"].values()))
        actual = [[r["pmid"],r["title"],r["total_score"],r["usefulness"],r["ai_memo"]] for r in data]
        self.assertEqual(actual,rows[1:])
        self.assertEqual(actual,candidate_score_rows(articles,scores))
        self.assertEqual(actual[0][2:4],["0","No (0/5)"])
        self.assertEqual(actual[2][2:4],["未評価","未評価"])
        self.assertEqual([r["pmid"] for r in data],["10","1","2"])
        self.assertEqual(from_tables(to_tables(d.payload())),d.payload())

    def test_projection_does_not_change_existing_snapshot_or_issue_content_version(self):
        d, _, _ = self.dataset()
        payload = d.payload()
        old = copy.deepcopy(payload); old.pop("issue_candidates")
        self.assertEqual(to_tables(payload)["Issues"],to_tables(old)["Issues"])
        self.assertEqual(to_tables(payload)["Appearances"],to_tables(old)["Appearances"])
        self.assertEqual(merge_payload(old,payload),payload)
        self.assertEqual(merge_payload(payload,payload),payload)

    def test_corrected_snapshot_and_repeat_pmid_keep_each_deliveries_values(self):
        first, _, _ = self.dataset()
        second, _, _ = self.dataset("run-two",[{"pmid":"10","total_score":25,"outpatient_usefulness":4}])
        combined = merge_payload(first.payload(),second.payload())
        self.assertEqual(combined["issue_candidates"]['["run-one","topic"]'][0]["total_score"],"0")
        self.assertEqual(combined["issue_candidates"]['["run-two","topic"]'][0]["total_score"],"25")
        correction, _, _ = self.dataset(scores=[{"pmid":"10","total_score":19}])
        updated = merge_payload(combined,correction.payload())
        rows = updated["issue_candidates"]['["run-one","topic"]']
        appearances = {a["snapshot_id"]:a for a in updated["appearances"]}
        self.assertEqual(appearances[rows[0]["snapshot_id"]]["text"]["importance"],"19")
        self.assertEqual(merge_payload(updated,correction.payload()),updated)
        self.assertEqual(from_tables(to_tables(updated)),updated)

    def test_candidate_ranges_match_and_reference_other_issue_is_rejected(self):
        first, _, _ = self.dataset()
        second, _, _ = self.dataset("run-two")
        payload=merge_payload(first.payload(),second.payload()); tables=to_tables(payload)
        for key,start,count in tables["IssueCandidateRows"][1:]:
            rows=tables["IssueCandidates"][int(start)-1:int(start)-1+int(count)]
            self.assertEqual(len(rows),3)
            self.assertTrue(all(row[0]==key for row in rows))
        bad=copy.deepcopy(payload)
        bad["issue_candidates"]['["run-one","topic"]'][0]["snapshot_id"]=bad["issue_candidates"]['["run-two","topic"]'][0]["snapshot_id"]
        with self.assertRaisesRegex(ValueError,"match delivery"): to_tables(bad)

    def test_publish_adds_optional_candidate_sheets_and_keeps_human_events(self):
        d, _, _=self.dataset(); payload=d.payload(); old=copy.deepcopy(payload);old.pop("issue_candidates")
        current=dict(to_tables(old), Reviews=[HEADERS["Reviews"],["op","1","1","read","now","my note","now","hash"]],
                     IssueReviews=[HEADERS["IssueReviews"]], Settings=[HEADERS["Settings"],["schema",SCHEMA],["instance","test-candidate"]])
        current.pop("IssueCandidates");current.pop("IssueCandidateRows")
        expected=dict(to_tables(payload),Reviews=current["Reviews"],IssueReviews=current["IssueReviews"],Settings=current["Settings"])
        store=GoogleStore.__new__(GoogleStore);store.read=MagicMock(side_effect=[current,expected,expected])
        store.verify=MagicMock(return_value={"parents":["parent"]});store.drive=MagicMock();store.sheets=MagicMock()
        store.drive.files.return_value.copy.return_value.execute.return_value={"id":"backup"}
        props=[{"properties":{"title":name,"sheetId":i,"gridProperties":{"rowCount":1000}}} for i,name in enumerate(current)]
        store.sheets.spreadsheets.return_value.get.return_value.execute.return_value={"sheets":props}
        with tempfile.TemporaryDirectory() as folder:
            self.assertTrue(store.publish("sheet","test-candidate",payload,folder)["changed"])
            self.assertFalse(store.publish("sheet","test-candidate",payload,folder)["changed"])
            backup=json.loads(next(Path(folder).glob("*.json")).read_text())
            self.assertEqual(backup["tables"]["Reviews"],current["Reviews"])
        requests=store.sheets.spreadsheets.return_value.batchUpdate.call_args.kwargs["body"]["requests"]
        self.assertEqual({r["addSheet"]["properties"]["title"] for r in requests if "addSheet" in r},{"IssueCandidates","IssueCandidateRows"})
        event_ids={p["properties"]["sheetId"] for p in props if p["properties"]["title"] in ("Reviews","IssueReviews")}
        for request in requests:
            update=request.get("updateCells",{})
            self.assertNotIn(update.get("range",update.get("start",{})).get("sheetId"),event_ids)

    def test_restore_copy_rebuilds_indexes_and_preserves_candidate_values_and_events(self):
        d, _, _ = self.dataset()
        for legacy in (False,True):
            payload=copy.deepcopy(d.payload())
            if legacy: payload.pop("issue_candidates")
            tables=dict(to_tables(payload),Reviews=[HEADERS["Reviews"],["op","1","1","read","now","my note","now","hash"]],IssueReviews=[HEADERS["IssueReviews"]])
            if legacy:
                tables.pop("IssueCandidates");tables.pop("IssueCandidateRows")
            empty={n:[h] for n,h in HEADERS.items()}
            verified=dict(to_tables(payload),Reviews=tables["Reviews"],IssueReviews=tables["IssueReviews"])
            store=GoogleStore.__new__(GoogleStore)
            store.create=MagicMock(return_value="new-sheet")
            store.read=MagicMock(side_effect=[empty,verified])
            store.sheets=MagicMock()
            store.sheets.spreadsheets.return_value.get.return_value.execute.return_value={"sheets":[{"properties":{"title":n,"sheetId":i}} for i,n in enumerate(HEADERS)]}
            self.assertEqual(store.restore_copy({"schema":SCHEMA,"instance":"old","tables":tables},"parent","new","test-copy"),"new-sheet")
            request=store.sheets.spreadsheets.return_value.batchUpdate.call_args.kwargs["body"]["requests"]
            self.assertTrue(request)
