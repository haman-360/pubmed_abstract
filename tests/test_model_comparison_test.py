import importlib.util
import unittest
from pathlib import Path

from automation_core import load_config


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "model_comparison_test.py"
SPEC = importlib.util.spec_from_file_location("model_comparison_test", MODULE_PATH)
comparison = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(comparison)


class ModelComparisonTest(unittest.TestCase):
    def test_comparison_keeps_old_and_new_models_after_production_migration(self):
        config = load_config("automation_config.json")
        arms = comparison.comparison_arms(config)
        self.assertEqual(arms["old"]["models"]["screen"]["name"], "gpt-5.6-luna")
        self.assertEqual(arms["old"]["models"]["final"]["name"], "gpt-5.6-terra")
        self.assertEqual(arms["new"]["models"]["screen"]["name"], "gpt-6-luna")
        self.assertEqual(arms["new"]["models"]["final"]["name"], "gpt-6-sol")
        self.assertEqual(config["models"]["screen"]["name"], "gpt-6-luna")

    def test_usage_and_cost_separates_cached_tokens(self):
        lines = [{"response": {"body": {"usage": {
            "input_tokens": 1000,
            "input_tokens_details": {"cached_tokens": 200, "cache_write_tokens": 100},
            "output_tokens": 400,
            "total_tokens": 1400,
        }}}}]
        result = comparison.usage_and_cost(lines, (1.0, 0.1, 1.25, 5.0))
        self.assertEqual(result["total_tokens"], 1400)
        self.assertEqual(result["cache_write_tokens"], 100)
        self.assertEqual(result["estimated_cost_usd"], 0.002845)

    def test_structured_results_rejects_wrong_pmid_and_invalid_json(self):
        info = {"expected": 3, "output": [
            {"custom_id": "one", "response": {"status_code": 200, "body": {"output_text": '{"pmid":"1"}'}}},
            {"custom_id": "two", "response": {"status_code": 200, "body": {"output_text": '{"pmid":"9"}'}}},
            {"custom_id": "three", "response": {"status_code": 200, "body": {"output_text": "invalid"}}},
        ], "errors": []}
        parsed, metrics = comparison.structured_results(info, {"1", "2", "3"})
        self.assertEqual(parsed, [{"pmid": "1"}])
        self.assertEqual(metrics["structured_successes"], 1)
        self.assertEqual(metrics["structured_success_rate"], 0.3333)
        self.assertEqual(metrics["missing_pmids"], ["2", "3"])
        self.assertEqual(len(metrics["failures"]), 2)


if __name__ == "__main__":
    unittest.main()
