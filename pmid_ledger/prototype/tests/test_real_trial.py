import copy
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo
from pmid_ledger.core import Dataset, to_tables, HEADERS, digest
from pmid_ledger.prototype.prepare_real_trial import prepare
from pmid_ledger.prototype.real_trial_session import execute
from pmid_ledger.prototype.sync_local import sync_metadata, SyncError
from pmid_ledger.prototype.fixture import fixture


def source():
    x = Dataset()
    date = datetime.now(ZoneInfo('Asia/Tokyo')).date().isoformat()
    x.snapshot('10000001', 'trial', 'topic', 'local-test', date, title='local trial', summary_ja='trial body')
    tables = to_tables(x.payload())
    return dict(format='SOURCE_SHEET_TRIAL_V1', tables=tables, window=dict(from_=date, through=date),
                reviews=[HEADERS['Reviews']], issue_reviews=[HEADERS['IssueReviews']])


class TrialTests(unittest.TestCase):
    def prepared(self):
        s = source()
        s['window']['from'] = s['window'].pop('from_')
        return s, prepare(s)

    def test_complete_small_source_and_state_copy_are_deterministic_except_new_operation_ids(self):
        s, p = self.prepared()
        self.assertEqual(p['tables'], s['tables'])
        self.assertEqual(p['manifest']['data_source'], 'real-copy')
        self.assertEqual(p['generation'], prepare(s)['generation'])
        self.assertLess(p['estimated_writes'], 10000)
        bad = copy.deepcopy(s)
        bad['tables']['Issues'][1][5] = 'different'
        with self.assertRaisesRegex(ValueError, 'complete_source_issues'):
            prepare(bad)
        bad = copy.deepcopy(s)
        bad['window']['through'] = '1900-01-01'
        with self.assertRaisesRegex(ValueError, 'recent_issues'):
            prepare(bad)

    def test_no_writes_without_verified_backup_and_no_synthetic_merge_into_real_copy(self):
        _, plan = self.prepared()
        class Transport:
            def __init__(self): self.actions = []; self.requests = 0
            def post(self, name, body):
                self.actions.append(name)
                self.requests += 1
                return dict(revision=plan['generation'], payload_hash=digest(plan['manifest']), manifest=plan['manifest'], tables=plan['tables'])
        t = Transport()
        with self.assertRaisesRegex(SyncError, 'verified_backup'):
            execute(plan, {}, t)
        self.assertEqual(t.actions, [])
        with self.assertRaisesRegex(SyncError, 'synthetic_merge_forbidden'):
            sync_metadata(fixture(), t)
        self.assertEqual(t.actions, ['status'])
        receipt = dict(verified=True, restore_readback_verified=True, snapshot=dict(active_revision='a'*64))
        self.assertTrue(execute(plan, receipt, t)['full_readback_verified'])
        self.assertFalse(any(a in t.actions for a in ['begin', 'chunk', 'publish']))
        with self.assertRaisesRegex(SyncError, 'fresh_real_trial_backup'):
            execute(plan, receipt, t, rollback=True)


if __name__ == '__main__':
    unittest.main()
