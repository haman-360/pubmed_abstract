import unittest
from unittest.mock import patch
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
