#!/usr/bin/env python3
"""Isolated, same-input Batch comparison for one PubMed topic.

This script never opens the production Drive ledger or sends a notification.
It writes a local JSON report for the TEST Actions artifact.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from automation_core import (  # noqa: E402
    choose_final_candidates, dump_jsonl, extract_response_json,
    final_batch_line, load_config, normalize_final_result, parse_jsonl,
    screen_batch_lines, search_by_name, validate_final_result,
)
from automation_services import OpenAIBatchClient  # noqa: E402
from pubmed_fetch import fetch_abstracts, search_pubmed_edat  # noqa: E402


TEST_PRICES = {
    "old": {
        "screen": (0.10, 0.01, 0.125, 0.60),  # GPT-5.6 Luna Batch
        "final": (1.0, 0.10, 1.25, 6.0),     # GPT-5.6 Terra Batch
    },
    "new": {
        "screen": (0.05, 0.005, 0.0625, 0.25),  # GPT-6 Luna Batch
        "final": (1.0, 0.10, 1.25, 5.0),       # GPT-6 Sol Batch
    },
}
TERMINAL = {"completed", "failed", "expired", "cancelled"}


def usage_and_cost(lines: list[dict], prices: tuple[float, float, float, float]) -> dict:
    counts = Counter()
    for line in lines:
        usage = (line.get("response") or {}).get("body", {}).get("usage") or {}
        counts["input_tokens"] += usage.get("input_tokens", 0) or 0
        details = usage.get("input_tokens_details") or {}
        counts["cached_input_tokens"] += details.get("cached_tokens", 0) or 0
        counts["cache_write_tokens"] += details.get("cache_write_tokens", 0) or 0
        counts["output_tokens"] += usage.get("output_tokens", 0) or 0
        counts["total_tokens"] += usage.get("total_tokens", 0) or 0
    inp, cached, write, out = prices
    cost = ((counts["input_tokens"] - counts["cached_input_tokens"] - counts["cache_write_tokens"]) * inp
            + counts["cached_input_tokens"] * cached
            + counts["cache_write_tokens"] * write
            + counts["output_tokens"] * out) / 1_000_000
    return {**counts, "estimated_cost_usd": round(cost, 6)}


def submit(client: OpenAIBatchClient, label: str, stage: str, lines: list[dict]) -> dict:
    uploaded = client.upload_jsonl(f"test_{label}_{stage}.jsonl", dump_jsonl(lines))
    batch = client.create_batch(uploaded["id"], "24h", {"purpose": "model-comparison-test", "arm": label, "stage": stage})
    print(f"{label}/{stage}: submitted {len(lines)} requests; batch={batch['id']}", flush=True)
    return {"batch_id": batch["id"], "expected": len(lines), "status": batch["status"]}


def collect(client: OpenAIBatchClient, submitted: dict, deadline: float, interval: int) -> dict:
    pending = set(submitted)
    while pending:
        for label in list(pending):
            info = submitted[label]
            batch = client.retrieve_batch(info["batch_id"])
            info["status"] = batch["status"]
            if batch["status"] not in TERMINAL:
                continue
            info["output"] = parse_jsonl(client.download_file(batch["output_file_id"]).decode()) if batch.get("output_file_id") else []
            info["errors"] = parse_jsonl(client.download_file(batch["error_file_id"]).decode()) if batch.get("error_file_id") else []
            pending.remove(label)
            print(f"{label}: {batch['status']}; output={len(info['output'])}; errors={len(info['errors'])}", flush=True)
        if pending:
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Batch still pending: {sorted(pending)}")
            time.sleep(min(interval, max(1, deadline - time.monotonic())))
    return submitted


def structured_results(info: dict, expected_pmids: set[str] | None = None) -> tuple[list[dict], dict]:
    parsed = []
    failures = []
    for line in info["output"]:
        try:
            if (line.get("response") or {}).get("status_code") != 200:
                raise ValueError(f"HTTP {(line.get('response') or {}).get('status_code')}")
            value = extract_response_json(line)
            if expected_pmids is not None and value.get("pmid") not in expected_pmids:
                raise ValueError("PMID mismatch")
            parsed.append(value)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            failures.append({"custom_id": line.get("custom_id"), "reason": str(exc)})
    failures.extend({"custom_id": x.get("custom_id"), "reason": str(x.get("error"))} for x in info["errors"])
    success_ids = {value.get("pmid") for value in parsed} if expected_pmids is not None else set()
    metrics = {
        "expected": info["expected"],
        "structured_successes": len(parsed),
        "structured_success_rate": round(len(parsed) / info["expected"], 4) if info["expected"] else None,
        "failures": failures,
        "missing_pmids": sorted(expected_pmids - success_ids) if expected_pmids is not None else [],
    }
    return parsed, metrics


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic", default="peds_asthma_update")
    parser.add_argument("--start", default="2026-09-12")
    parser.add_argument("--end", default="2026-09-23")
    parser.add_argument("--output", default="model_comparison_test.json")
    parser.add_argument("--max-wait-minutes", type=int, default=330)
    parser.add_argument("--poll-seconds", type=int, default=60)
    args = parser.parse_args()
    date.fromisoformat(args.start)
    date.fromisoformat(args.end)
    config = load_config(Path(__file__).resolve().parents[1] / "automation_config.json")
    if args.topic not in config["topics"]:
        parser.error("unknown topic")
    query = search_by_name(args.topic)["query"]
    pmids, count = search_pubmed_edat(query, args.start, args.end)
    articles = fetch_abstracts(pmids)
    if not articles:
        raise RuntimeError("No abstracts available for comparison")
    print(f"{args.topic}: PubMed matches={count}; abstracts={len(articles)}", flush=True)
    arms = {
        "old": config,
        "new": json.loads(json.dumps(config)),
    }
    arms["new"]["models"]["screen"].update(name="gpt-6-luna", reasoning_effort="low")
    arms["new"]["models"]["final"].update(name="gpt-6-sol", reasoning_effort="medium")
    client = OpenAIBatchClient()
    deadline = time.monotonic() + args.max_wait_minutes * 60
    report = {"test": True, "topic": args.topic, "edat_start": args.start, "edat_end": args.end,
              "pubmed_count": count, "abstract_count": len(articles), "pmids": [x["pmid"] for x in articles],
              "arms": {}}
    output_path = Path(args.output)
    try:
        screen_batches = {
            label: submit(client, label, "screen", screen_batch_lines(f"test-{label}", articles, arm))
            for label, arm in arms.items()
        }
        report["screen_batches"] = {label: info["batch_id"] for label, info in screen_batches.items()}
        collect(client, screen_batches, deadline, args.poll_seconds)
        final_batches = {}
        for label, arm in arms.items():
            prices = TEST_PRICES[label]["screen"]
            scores, metrics = structured_results(screen_batches[label], set(report["pmids"]))
            metrics["usage"] = usage_and_cost(screen_batches[label]["output"], prices)
            report["arms"][label] = {"screen_model": arm["models"]["screen"]["name"],
                                     "final_model": arm["models"]["final"]["name"],
                                     "screen": metrics, "scores": scores}
            if not scores:
                continue
            candidates = choose_final_candidates(scores, arm)
            report["arms"][label]["candidate_pmids"] = [x["pmid"] for x in candidates]
            final_batches[label] = submit(client, label, "final", [final_batch_line(
                f"test-{label}", config["topics"][args.topic]["display_name"], candidates, articles, arm)])
        if final_batches:
            report["final_batches"] = {label: info["batch_id"] for label, info in final_batches.items()}
            collect(client, final_batches, deadline, args.poll_seconds)
        for label, batch in final_batches.items():
            arm = arms[label]
            prices = TEST_PRICES[label]["final"]
            results, metrics = structured_results(batch)
            metrics["usage"] = usage_and_cost(batch["output"], prices)
            if results:
                raw = results[0]
                candidate_pmids = set(report["arms"][label]["candidate_pmids"])
                try:
                    validate_final_result(raw, candidate_pmids,
                        config["selection"]["selected_n"], config["selection"]["alternate_n"])
                    metrics["raw_result_valid"] = True
                except ValueError as exc:
                    metrics["raw_result_valid"] = False
                    metrics["raw_validation_error"] = str(exc)
                normalized, warnings = normalize_final_result(raw, candidate_pmids,
                    config["selection"]["selected_n"], config["selection"]["alternate_n"])
                try:
                    validate_final_result(normalized, candidate_pmids,
                        config["selection"]["selected_n"], config["selection"]["alternate_n"])
                    metrics["valid_after_normalization"] = True
                except ValueError as exc:
                    metrics["valid_after_normalization"] = False
                    metrics["validation_error"] = str(exc)
                metrics["normalization_warnings"] = warnings
                metrics["raw_result"] = raw
                metrics["selected_pmids"] = [x["pmid"] for x in normalized["selected"]]
                metrics["alternate_pmids"] = [x["pmid"] for x in normalized["alternates"]]
            report["arms"][label]["final"] = metrics
    finally:
        output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"TEST report: {output_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
