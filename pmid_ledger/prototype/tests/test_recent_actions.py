import base64
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from pmid_ledger.prototype import recent_actions_setup as setup
from pmid_ledger.prototype.sync_local import SyncError

class API:
 def __init__(self,text,public=True):self.text=text;self.public=public;self.calls=[]
 def close(self):pass
 def request(self,method,path,value=None,missing=False):
  self.calls.append((method,path,value))
  if method!='GET':return {}
  if path=='':return {'visibility':'public' if self.public else 'private'}
  if path=='/actions/secrets':return {'secrets':[{'name':n} for n in ['GOOGLE_AUTHORIZED_USER_JSON','PMID_LEDGER_SHEET_ID']]}
  if '/contents/' in path:return {'content':base64.b64encode(self.text).decode()}
  if path.endswith('/public-key'):return {'key':base64.b64encode(b'x'*32).decode(),'key_id':'public-test-key'}
  return None

class ActionsSetupTests(unittest.TestCase):
 def test_cost_and_reviewed_workflow_checks_precede_any_mutation(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'.github/workflows').mkdir(parents=True);text=b'runs-on: ubuntu-latest\n';(root/'.github/workflows'/setup.WORKFLOW).write_bytes(text)
   with patch.object(setup,'ROOT',root):
    for api in [API(text,False),API(text+b'changed')]:
     with self.assertRaises(SyncError):setup.preflight(api)
     self.assertTrue(all(m=='GET' for m,p,v in api.calls))
    api=API(text)
    class Box:
     def __init__(self,key):pass
     def encrypt(self,value):return b'opaque-encrypted-by-library'
    with patch.object(setup,'GitHub',return_value=api),patch.object(setup,'encryption',return_value=(lambda k:k,Box)):
     self.assertTrue(setup.configure('local-test.access','local-secret-not-real'))
    updates=[(p,v) for m,p,v in api.calls if m=='PUT'];self.assertEqual(len(updates),2)
    self.assertEqual({p.rsplit('/',1)[-1] for p,v in updates},{'PMID_TEST_ACCESS_CLIENT_ID','PMID_TEST_ACCESS_CLIENT_SECRET'})
    self.assertTrue(all(set(v)=={'encrypted_value','key_id'} for p,v in updates))
    self.assertFalse(any('local-secret' in str(v) for p,v in updates))
    self.assertEqual(api.calls[-1],('POST','/actions/workflows/pmid-ledger-test.yml/dispatches',{'ref':'main'}))
