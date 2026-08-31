import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from pmid_ledger.core import Dataset, HEADERS, SCHEMA, canonical, day, digest, from_tables, merge_payload, to_tables
from pmid_ledger.migrate import parse_text
from pmid_ledger.google_store import GoogleStore


class LedgerTests(unittest.TestCase):
    def dataset(self):
        d = Dataset()
        d.paper('123', 'fixture', '感染症', '2026-08-20', title='A', journal='J')
        d.snapshot('123', 'issue1', '感染症', 'fixture', '2026-08-21', 'A', 'selected', summary_ja='日本語'*20000)
        return d

    def test_roundtrip_long_text_and_dates(self):
        d = self.dataset()
        self.assertEqual(from_tables(to_tables(d.payload())), d.payload())
        self.assertGreater(len(to_tables(d.payload())['Texts']), 2)
        self.assertEqual(day('2026-08'), '')
        self.assertEqual(day('2026-08-20T23:59:00Z'), '2026-08-21')

    def test_migration_idempotent_and_preserves_revised_snapshot(self):
        p = self.dataset().payload()
        self.assertEqual(merge_payload(p, p), p)
        other = self.dataset().payload()
        other['appearances'][0]['text']['summary_ja'] = '訂正された本文'
        merged = merge_payload(p, other)
        self.assertEqual(len(merged['papers']), 1)
        self.assertEqual(len(merged['appearances']), 2)
        self.assertEqual(merge_payload(merged, other), merged)
        self.assertNotIn('review_status', canonical(merged))
        self.assertNotIn('note', canonical(merged))

    def test_run_includes_all_candidates_but_not_undelivered(self):
        d = Dataset()
        manifest = {'run_id':'r', 'topic':'感染症', 'components':{'current_doc':{'state':'COMPLETED','file_id':'doc'}}}
        articles = [{'pmid':'1','title':'選定'}, {'pmid':'2','title':'候補'}, {'pmid':'3','title':'評価なし'}]
        scores = [{'pmid':'2','one_line_assessment':'候補の既存評価'}]
        final = {'selected':[{'pmid':'1','why_important':'既存の理由','clinical_impact':'既存の臨床影響'}]}
        d.run(manifest, articles, scores, final, 'source')
        self.assertEqual(len(d.appearances), 3)
        self.assertTrue(all(not a['delivered_date'] for a in d.appearances.values()))
        manifest['components']['current_doc']['state'] = 'PENDING'
        other = Dataset()
        other.run(manifest, articles, scores, final, 'source')
        self.assertEqual(len(other.papers), 3)
        self.assertEqual(other.appearances, {})

    def test_recover_saved_prose_with_section_boundaries(self):
        text = '''# 第1部：日本語要約
①タイトルA
②PMID
12345
③なぜ重要か
既存の評価
④臨床への影響
既存の影響
---
①タイトルB
②PMID
23456
③なぜ重要か
Bだけの要約
# 第2部：英語Abstract
PMID: 12345
Do not mix this abstract with the Japanese summary.
# 第3部：候補論文スコア一覧
| PMID | タイトル | スコア | 有用 | メモ |
| 12345 | A | 12 | Yes | Aの一行評価 |
| 34567 | C | 8 | No | Cの一行評価 |
'''
        d = Dataset()
        parse_text(d, text, 'fixture.txt', 'issue')
        self.assertEqual(set(d.papers), {'12345','23456','34567'})
        first = next(a for a in d.appearances.values() if a['pmid']=='12345')
        self.assertNotIn('Bだけ', first['text']['summary_ja'])
        self.assertNotIn('Do not mix', first['text']['summary_ja'])
        self.assertEqual(first['text']['one_line_assessment'], 'Aの一行評価')

    def test_formula_text_is_written_as_typed_string(self):
        request = GoogleStore.cells(1, [['=IMPORTXML("bad")']])
        self.assertEqual(request['updateCells']['rows'][0]['values'][0]['userEnteredValue'], {'stringValue':'=IMPORTXML("bad")'})

    def test_publish_never_targets_reviews_and_backs_up_before_atomic_update(self):
        store = GoogleStore.__new__(GoogleStore)
        empty = Dataset().payload()
        current = dict(to_tables(empty), Reviews=[HEADERS['Reviews'], ['operation-1','123','1','read','','private note','','hash']], Settings=[HEADERS['Settings'], ['schema',SCHEMA], ['instance','test']], IssueReviews=[HEADERS['IssueReviews'], ['issue-operation','["issue","topic"]','1','completed','body','now','hash']])
        published = dict(to_tables(self.dataset().payload()), Reviews=current['Reviews'], Settings=current['Settings'], IssueReviews=current['IssueReviews'])
        store.read = MagicMock(side_effect=[current,published])
        store.verify = MagicMock(return_value={'parents':['parent']})
        store.drive = MagicMock()
        store.drive.files.return_value.copy.return_value.execute.return_value={'id':'backup'}
        store.sheets = MagicMock()
        store.sheets.spreadsheets.return_value.get.return_value.execute.return_value = {'sheets':[{'properties':{'title':name,'sheetId':i,'gridProperties':{'rowCount':1000}}} for i,name in enumerate(HEADERS)]}
        with tempfile.TemporaryDirectory() as temp:
            result = store.publish('sheet','test',self.dataset().payload(),temp)
            self.assertTrue(result['changed'])
            backup = json.loads(next(Path(temp).glob('*.json')).read_text())
            self.assertEqual(backup['tables']['Reviews'],current['Reviews'])
            self.assertEqual(backup['tables']['IssueReviews'],current['IssueReviews'])
        requests = store.sheets.spreadsheets.return_value.batchUpdate.call_args.kwargs['body']['requests']
        review_id = list(HEADERS).index('Reviews')
        issue_id = list(HEADERS).index('IssueReviews')
        for request in requests:
            self.assertNotIn('"sheetId": '+str(review_id),json.dumps(request))
            self.assertNotIn('"sheetId": '+str(issue_id),json.dumps(request))
        self.assertEqual(store.sheets.spreadsheets.return_value.batchUpdate.call_count,1)

    def test_old_ledger_read_without_optional_issue_sheet(self):
        store = GoogleStore.__new__(GoogleStore)
        store.verify = MagicMock()
        store.sheets = MagicMock()
        names = [n for n in HEADERS if n != 'IssueReviews']
        tables = {n:[HEADERS[n]] for n in names}
        tables['Settings'] += [['schema',SCHEMA],['instance','test']]
        store.sheets.spreadsheets.return_value.get.return_value.execute.return_value = {'sheets':[{'properties':{'title':n}} for n in names]}
        store.sheets.spreadsheets.return_value.values.return_value.batchGet.return_value.execute.return_value = {'valueRanges':[{'values':tables[n]} for n in names]}
        result = store.read('sheet','test')
        self.assertEqual(result['IssueReviews'],[HEADERS['IssueReviews']])
        self.assertEqual(store.sheets.spreadsheets.return_value.values.return_value.batchGet.call_args.kwargs['ranges'],names)

    def test_no_new_ai_client_imports(self):
        for path in Path('pmid_ledger').glob('*.py'):
            source=path.read_text()
            self.assertNotIn('import pubmed_automation',source)
            self.assertNotIn('import openai',source)
            self.assertNotIn('api.openai.com',source)

    def test_future_doc_links_and_utf16_ranges(self):
        from automation_core import render_notebook_doc
        from automation_services import GoogleWorkspaceClient, split_score_table
        url = 'https://script.google.com/macros/s/deployment/exec'
        text = render_notebook_doc('分野', 'r', [{'pmid':'123','title':'😀 Test'}], [], {'selected':[]}, ledger_url=url)
        self.assertIn(url+'?pmid=123',text)
        from urllib.parse import quote
        self.assertIn(url+'?issue='+quote('["r","分野"]',safe=''), text)
        body, rows = split_score_table(text)
        self.assertEqual(len(rows[0]), 5)
        client = GoogleWorkspaceClient.__new__(GoogleWorkspaceClient)
        client.docs = MagicMock()
        client.docs.documents.return_value.get.return_value.execute.return_value={'body':{'content':[]}}
        # No score table: test actual outgoing style range against the Unicode text.
        body = '😀 日本語\n'+url+'?pmid=123\n'
        client.replace_doc_text('doc',body)
        requests=client.docs.documents.return_value.batchUpdate.call_args.kwargs['body']['requests']
        link=requests[-1]['updateTextStyle']
        self.assertEqual(link['range']['startIndex'],len('😀 日本語\n'.encode('utf-16-le'))//2+1)
        self.assertEqual(link['textStyle']['link']['url'],url+'?pmid=123')


if __name__=='__main__':
    unittest.main()
