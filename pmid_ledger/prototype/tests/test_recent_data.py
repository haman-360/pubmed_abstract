import copy
from datetime import datetime
from zoneinfo import ZoneInfo
import unittest
from pmid_ledger.core import Dataset,to_tables,HEADERS
from pmid_ledger.prototype.recent_data import plan_recent,window
from pmid_ledger.prototype.sync_local import SyncError

class RecentDataTests(unittest.TestCase):
 def source(self):
  x=Dataset()
  for p,issue,date in [('10000001','old','2026-09-05'),('10000002','boundary','2026-09-06'),('10000003','new','2026-11-06')]:x.snapshot(p,issue,'topic','local-test',date,title='test',summary_ja='body '+p)
  tables=to_tables(x.payload());tables.update(Reviews=[HEADERS['Reviews']],IssueReviews=[HEADERS['IssueReviews']]);return tables
 def test_calendar_window_complete_membership_and_deterministic_chunks(self):
  now=datetime(2026,11,6,tzinfo=ZoneInfo('Asia/Tokyo'));self.assertEqual(window(now),{'from':'2026-09-06','through':'2026-11-06'})
  self.assertEqual(window(datetime(2026,4,30,tzinfo=ZoneInfo('Asia/Tokyo')))['from'],'2026-02-28')
  p=plan_recent(self.source(),now);self.assertEqual(len(p['tables']['Papers'])-1,2);self.assertEqual(len(p['tables']['Issues'])-1,2)
  self.assertEqual(p,plan_recent(self.source(),now));self.assertEqual(p['manifest']['data_source'],'recent-copy')
 def test_partial_source_and_oversized_source_notes_are_rejected(self):
  now=datetime(2026,11,6,tzinfo=ZoneInfo('Asia/Tokyo'));s=self.source();s['Appearances']=s['Appearances'][:1]
  with self.assertRaises((ValueError,SyncError)):plan_recent(s,now)
  s=self.source();s['Reviews'].append(['source-op','10000002','1','want_fulltext','','x'*2001,'',''])
  with self.assertRaisesRegex(SyncError,'unsupported_source_review'):plan_recent(s,now)

class PendingDataTests(unittest.TestCase):
 source=RecentDataTests.source
 def test_unfinished_queue_has_no_sliding_date_cutoff_and_local_state_wins(self):
  now=datetime(2026,11,6,tzinfo=ZoneInfo('Asia/Tokyo'));source=self.source()
  newest=next(r for r in source['Issues'][1:] if r[1]=='new')
  state={'issues':[{'issue_key':newest[0],'status':'completed','content_version':newest[5]}],'reviews':[]}
  p=plan_recent(source,now,queue_state=state)
  self.assertEqual({r[1] for r in p['tables']['Issues'][1:]},{'old','boundary'})
  self.assertEqual(p['manifest']['trial_window']['from'],'1900-01-01')
  state['issues'][0]['content_version']='content changed'
  self.assertEqual(len(plan_recent(source,now,queue_state=state)['tables']['Issues'])-1,3)
 def test_completed_source_wish_and_memo_survive_without_its_body(self):
  now=datetime(2026,11,6,tzinfo=ZoneInfo('Asia/Tokyo'));s=self.source();row=next(r for r in s['Issues'][1:] if r[1]=='new')
  s['Reviews'].append(['source-op','10000003','1','want_fulltext','','keep original note','',''])
  s['IssueReviews'].append(['source-done',row[0],'1','completed',row[5],'',''])
  p=plan_recent(s,now,queue_state={'issues':[],'reviews':[]})
  self.assertNotIn(row[0],{r[0] for r in p['tables']['Issues'][1:]})
  self.assertIn('10000003',{r[0] for r in p['tables']['Papers'][1:]})
  self.assertNotIn('10000003',{r[1] for r in p['tables']['Appearances'][1:]})
  self.assertIn({'pmid':'10000003','status':'want_fulltext','note':'keep original note'},p['review_seeds'])
  self.assertLess(len(p['tables']['Texts']),len(s['Texts']))
  reopened=plan_recent(s,now,queue_state={'issues':[],'reviews':['10000003'],'review_statuses':{'10000003':'unreviewed'}})
  self.assertIn(row[0],{r[0] for r in reopened['tables']['Issues'][1:]})
 def test_empty_queue_is_valid_and_source_cannot_override_local_reopen(self):
  now=datetime(2026,11,6,tzinfo=ZoneInfo('Asia/Tokyo'));s=self.source()
  state={'issues':[{'issue_key':r[0],'status':'completed','content_version':r[5]} for r in s['Issues'][1:]],'reviews':[]}
  p=plan_recent(s,now,queue_state=state);self.assertEqual(len(p['tables']['Issues']),1);self.assertEqual(p['manifest']['pending_queue']['deferred_issues'],0)
  state['issues'][0]['status']='unreviewed'
  self.assertEqual(len(plan_recent(s,now,queue_state=state)['tables']['Issues']),2)
 def test_bounded_queue_refills_from_older_issues_without_ever_completing_them(self):
  now=datetime(2026,11,6,tzinfo=ZoneInfo('Asia/Tokyo'));s=self.source()
  state={'issues':[],'reviews':[],'limit':1};p=plan_recent(s,now,queue_state=state)
  self.assertEqual(p['tables']['Issues'][1][1],'new');self.assertEqual(p['manifest']['pending_queue']['deferred_issues'],2)
  r=p['tables']['Issues'][1];state['issues']=[{'issue_key':r[0],'status':'completed','content_version':r[5]}]
  p=plan_recent(s,now,queue_state=state);self.assertEqual(p['tables']['Issues'][1][1],'boundary');self.assertEqual(p['manifest']['pending_queue']['deferred_issues'],1)
