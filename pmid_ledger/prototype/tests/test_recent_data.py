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
  for p,issue,date in [('10000001','old','2026-09-05'),('10000002','boundary','2026-09-06'),('10000003','new','2026-11-06')]:x.snapshot(p,issue,'topic','local-test',date,title='test',summary_ja='body')
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
