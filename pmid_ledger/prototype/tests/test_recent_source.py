import unittest
import re
from unittest.mock import patch
from pmid_ledger.core import Dataset,to_tables,HEADERS
from pmid_ledger.prototype.recent_source import read_source
from pmid_ledger.prototype.recent_data import NAMES
from pmid_ledger.prototype.sync_local import SyncError

class Result:
 def __init__(self,value):self.value=value
 def execute(self,**kwargs):return self.value
class Source:
 def __init__(self,changed=False):self.calls=[];self.version=0;self.changed=changed
 def files(self):return self
 def spreadsheets(self):return self
 def values(self):return self
 def get(self,**kw):
  self.calls.append(('get',kw))
  if 'fileId' in kw:
   self.version+=1
   return Result({'mimeType':'application/vnd.google-apps.spreadsheet','version':str(self.version if self.changed else 1),'appProperties':{'pmidLedgerInstance':'pubmed-review-production-v1'},'permissions':[{'role':'owner'}]})
  return Result({'sheets':[{'properties':{'title':n,'gridProperties':{'rowCount':10}}} for n in NAMES]})
 def batchGet(self,**kw):
  self.calls.append(('batchGet',kw));return Result({'valueRanges':[{'values':[[n]]} for n in NAMES]})
class ReadOnlySourceTests(unittest.TestCase):
 def read(self,source):
  with patch('google.oauth2.credentials.Credentials.from_authorized_user_info',return_value=object()),patch('googleapiclient.discovery.build',return_value=source):return read_source('local-test-id','{}')
 def test_only_bounded_reads_without_settings_and_source_version_guard(self):
  s=Source();self.assertEqual(set(self.read(s)),set(NAMES));self.assertEqual([c[0] for c in s.calls],['get','get','batchGet','get'])
  ranges=s.calls[2][1]['ranges'];self.assertTrue(all(r.endswith('10') for r in ranges));self.assertFalse(any('Settings' in r for r in ranges))
  with self.assertRaisesRegex(SyncError,'source_changed_during_read'):self.read(Source(changed=True))

 def test_queue_reads_only_unfinished_text_ranges_and_preserves_the_version_guard(self):
  data=Dataset()
  data.snapshot('10000001','old','topic','test','2025-01-01',title='old',summary_ja='old body')
  data.snapshot('10000002','new','topic','test','2026-11-01',title='new',summary_ja='new body')
  tables=to_tables(data.payload());tables.update(Reviews=[HEADERS['Reviews']],IssueReviews=[HEADERS['IssueReviews']])
  done=next(r for r in tables['Issues'][1:] if r[1]=='old')
  state={'issues':[{'issue_key':done[0],'status':'completed','content_version':done[5]}],'reviews':[]}
  class Indexed(Source):
   def get(self,**kw):
    if 'fileId' in kw:return super().get(**kw)
    self.calls.append(('get',kw))
    return Result({'sheets':[{'properties':{'title':n,'gridProperties':{'rowCount':len(v)}}} for n,v in tables.items()]})
   def batchGet(self,**kw):
    self.calls.append(('batchGet',kw));values=[]
    for query in kw['ranges']:
     match=re.fullmatch(r"'([^']+)'!A(\d+):[A-Z]+(\d+)",query)
     name,first,last=match.groups();values.append({'values':tables[name][int(first)-1:int(last)]})
    return Result({'valueRanges':values})
  def run(source):
   with patch('google.oauth2.credentials.Credentials.from_authorized_user_info',return_value=object()),patch('googleapiclient.discovery.build',return_value=source):return read_source('local-test-id','{}',queue_state=state)
  reader=Indexed();source=run(reader)
  self.assertEqual(len(source['Texts']),2)
  self.assertIn('new body',source['Texts'][1][2]);self.assertNotIn('old body',str(source['Texts']))
  first=reader.calls[2][1]['ranges'];self.assertFalse(any(q.startswith("'Texts'!") for q in first));self.assertTrue(any(q.startswith("'TextRows'!") for q in first))
  self.assertEqual([c[0] for c in reader.calls],['get','get','batchGet','batchGet','get'])
  with self.assertRaisesRegex(SyncError,'source_changed_during_read'):run(Indexed(changed=True))
