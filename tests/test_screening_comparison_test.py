import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from automation_core import load_config
from scripts import screening_comparison_test as experiment


class ScreeningComparisonTest(unittest.TestCase):
    def test_only_screen_model_differs_and_production_is_unchanged(self):
        config = load_config('automation_config.json')
        original = copy.deepcopy(config)
        arms = experiment.arms(config)
        self.assertEqual(config, original)
        self.assertEqual(arms['terra']['models']['screen']['name'], 'gpt-6.1-terra')
        for arm in arms.values():
            self.assertEqual(arm['models']['screen']['reasoning_effort'], 'low')
            self.assertEqual(arm['models']['final']['name'], 'gpt-6-sol')
            self.assertEqual(arm['models']['final']['reasoning_effort'], 'medium')
        arms['terra']['models']['screen']['name'] = 'gpt-6-luna'
        self.assertEqual(arms['terra'], arms['luna'])

    def test_uncertain_submission_is_saved_and_never_retried(self):
        client = Mock()
        client.upload_jsonl.return_value = {'id': 'file_test'}
        client.create_batch.side_effect = TimeoutError('unknown outcome')
        state = {}
        report = {'experiment': 'test', 'state': state}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'report.json'
            with self.assertRaises(TimeoutError):
                experiment.submit_once(client, path, report, state, [], 'topic', 'terra', 'screen')
            self.assertIn('file_test', path.read_text())
            with self.assertRaisesRegex(RuntimeError, 'Uncertain'):
                experiment.submit_once(client, path, report, state, [], 'topic', 'terra', 'screen')
        self.assertEqual(client.create_batch.call_count, 1)

    def test_resume_polls_existing_ids_and_reuses_saved_articles(self):
        config = load_config('automation_config.json')
        data = {'articles': [{'pmid': '1'}], 'arms': {label: {'screen': {
            'batch_id': label, 'expected': 1, 'submission_started': True}}
            for label in ('luna', 'terra')}}
        data['input_hash'] = experiment.content_hash(data['articles'])
        report = {'configs': experiment.arms(config), 'topics': {'topic': data}}
        client = Mock()
        client.retrieve_batch.return_value = {'status': 'in_progress'}
        with tempfile.TemporaryDirectory() as folder:
            self.assertFalse(experiment.advance(client, Path(folder) / 'report.json', report))
        self.assertEqual(client.retrieve_batch.call_count, 2)
        client.upload_jsonl.assert_not_called()
        client.create_batch.assert_not_called()

    def test_request_pmid_mismatch_and_duplicate_are_rejected(self):
        import json
        value = dict(pmid='1', total_score=5, outpatient_usefulness=1,
                     practice_change=1, evidence_strength=1, pediatric_directness=1, novelty=1)
        line = {'custom_id': 'test:1', 'response': {'status_code': 200,
                'body': {'output_text': json.dumps(value)}}}
        state = {'expected': 1, 'output': [line], 'errors': []}
        experiment.screen_results(state, {'1'})
        line['custom_id'] = 'test:2'
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            experiment.screen_results(state, {'1'})
        line['custom_id'] = 'test:1'
        state['output'].append(copy.deepcopy(line))
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            experiment.screen_results(state, {'1'})

    def test_partial_screen_cannot_proceed_to_final(self):
        with self.assertRaisesRegex(ValueError, 'Incomplete screening'):
            experiment.screen_results({'expected': 2, 'output': [], 'errors': []}, {'1', '2'})


if __name__ == '__main__':
    unittest.main()
