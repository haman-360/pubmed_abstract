#!/usr/bin/env python3
"""Isolated Luna/Terra screening experiment; resume saved Batch IDs, never retry POSTs."""
from __future__ import annotations

import argparse
import copy
import json
import sys
import time
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from automation_core import (choose_final_candidates, content_hash, dump_jsonl,
    final_batch_line, load_config, parse_jsonl, screen_batch_lines,
    search_by_name, validate_final_result)
from automation_services import OpenAIBatchClient
from pubmed_fetch import fetch_abstracts, search_pubmed_edat
from scripts.model_comparison_test import TERMINAL, structured_results, usage_and_cost

TOPICS = ("peds_asthma_update", "ped_nephrology_update", "primary_care_review")
PRICES = {"luna": (0.05, 0.005, 0.0625, 0.25),
          "terra": (0.50, 0.025, 0.625, 2.50),
          "final": (1.0, 0.1, 1.25, 5.0)}


def arms(config):
    result = {}
    for label, model in (("luna", "gpt-6-luna"), ("terra", "gpt-6.1-terra")):
        arm = copy.deepcopy(config)
        arm["models"]["screen"].update(name=model, reasoning_effort="low")
        arm["models"]["final"].update(name="gpt-6-sol", reasoning_effort="medium")
        result[label] = arm
    return result


def save(path, report):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def prepare(config):
    report = {"test": True, "experiment": "luna-terra-2026-11-16", "status": "prepared",
              "start": "2026-10-19", "end": "2026-11-15", "configs": arms(config),
              "prices": PRICES, "topics": {}}
    for topic in TOPICS:
        pmids, count = search_pubmed_edat(search_by_name(topic)["query"], report["start"], report["end"])
        if not 1 <= count <= 100:
            raise ValueError(f"{topic}: expected 1–100 papers, found {count}; no Batch submitted")
        articles = fetch_abstracts(pmids)
        if {x["pmid"] for x in articles} != set(pmids) or len(articles) != len(pmids):
            raise ValueError(f"{topic}: incomplete/duplicate PubMed input")
        report["topics"][topic] = {"articles": articles, "input_hash": content_hash(articles),
                                  "pubmed_count": count, "arms": {"luna": {}, "terra": {}}}
        print(f"{topic}: {len(articles)} articles", flush=True)
    return report


def submit_once(client, path, report, state, lines, topic, label, stage):
    if state.get("submission_started"):
        raise RuntimeError("Uncertain Batch submission: inspect API metadata; do not resubmit")
    state.update(submission_started=True, expected=len(lines), request_hash=content_hash(lines))
    save(path, report)
    uploaded = client.upload_jsonl(f"{topic}_{label}_{stage}.jsonl", dump_jsonl(lines))
    state["input_file_id"] = uploaded["id"]
    save(path, report)
    batch = client.create_batch(uploaded["id"], "24h", {
        "purpose": report["experiment"], "topic": topic, "arm": label, "stage": stage})
    state.update(batch_id=batch["id"], status=batch["status"])
    save(path, report)
    print(f"{topic}/{label}/{stage}: {batch['id']}", flush=True)


def read_with_retry(operation, *args):
    """Retry transient GET failures only; paid submissions must never use this."""
    for attempt in range(4):
        try:
            return operation(*args)
        except (RuntimeError, urllib.error.URLError, TimeoutError) as exc:
            cause = exc.__cause__ or exc
            transient = (cause.code in {408, 429, 500, 502, 503, 504}
                         if isinstance(cause, urllib.error.HTTPError)
                         else isinstance(cause, (urllib.error.URLError, TimeoutError)))
            if not transient or attempt == 3:
                raise
            print(f"Transient read failure; retry {attempt + 1}/3", flush=True)
            time.sleep(5 * (attempt + 1))


def poll(client, state):
    if state.get("collected"):
        return
    batch = read_with_retry(client.retrieve_batch, state["batch_id"])
    state["status"] = batch["status"]
    if batch["status"] not in TERMINAL:
        return
    state["output"] = parse_jsonl(read_with_retry(client.download_file, batch["output_file_id"]).decode()) if batch.get("output_file_id") else []
    state["errors"] = parse_jsonl(read_with_retry(client.download_file, batch["error_file_id"]).decode()) if batch.get("error_file_id") else []
    state["batch_errors"] = batch.get("errors")
    state["collected"] = True


def screen_results(state, expected_pmids):
    scores, metrics = structured_results(state, expected_pmids)
    seen = set()
    for line in state["output"]:
        if (line.get("response") or {}).get("status_code") != 200:
            continue
        from automation_core import extract_response_json
        value = extract_response_json(line)
        pmid = value.get("pmid")
        if line.get("custom_id", "").rsplit(":", 1)[-1] != pmid or pmid in seen:
            raise ValueError("Duplicate or request/response PMID mismatch")
        seen.add(pmid)
        axes = ("outpatient_usefulness", "practice_change", "evidence_strength", "pediatric_directness", "novelty")
        if any(type(value.get(k)) is not int or not 0 <= value[k] <= 5 for k in axes):
            raise ValueError("Invalid screening score")
        if value.get("total_score") != sum(value[k] for k in axes):
            raise ValueError("Screening score sum mismatch")
    if metrics["failures"] or metrics["missing_pmids"] or len(scores) != len(expected_pmids):
        raise ValueError("Incomplete screening; final selection blocked")
    return scores, metrics


def advance(client, path, report):
    finished = True
    for topic, data in report["topics"].items():
        if content_hash(data["articles"]) != data["input_hash"]:
            raise ValueError("Saved inputs changed")
        for label, result in data["arms"].items():
            config = report["configs"][label]
            screen = result.setdefault("screen", {})
            if not screen.get("batch_id"):
                submit_once(client, path, report, screen,
                    screen_batch_lines(f"test-{topic}-{label}", data["articles"], config), topic, label, "screen")
            poll(client, screen)
            save(path, report)
            if not screen.get("collected"):
                finished = False
                continue
            if "scores" not in result and "invalid" not in result:
                try:
                    scores, metrics = screen_results(screen, {x["pmid"] for x in data["articles"]})
                    result["scores"] = scores
                    result["screen_metrics"] = metrics
                    result["candidate_pmids"] = [x["pmid"] for x in choose_final_candidates(scores, config)]
                except (ValueError, TypeError, KeyError) as exc:
                    result["invalid"] = str(exc)
                screen["usage"] = usage_and_cost(screen["output"], tuple(report["prices"][label]))
                save(path, report)
            if "invalid" in result:
                continue
            final = result.setdefault("final", {})
            if not final.get("batch_id"):
                candidates = choose_final_candidates(result["scores"], config)
                line = final_batch_line(f"test-{topic}-{label}", config["topics"][topic]["display_name"],
                                        candidates, data["articles"], config)
                submit_once(client, path, report, final, [line], topic, label, "final")
            poll(client, final)
            if not final.get("collected"):
                finished = False
            elif "final_metrics" not in result:
                values, metrics = structured_results(final)
                final["usage"] = usage_and_cost(final["output"], tuple(report["prices"]["final"]))
                try:
                    if len(values) != 1 or metrics["failures"]:
                        raise ValueError("Incomplete final output")
                    validate_final_result(values[0], set(result["candidate_pmids"]),
                        config["selection"]["selected_n"], config["selection"]["alternate_n"])
                    result["selection"] = values[0]
                    metrics["raw_result_valid"] = True
                except (ValueError, KeyError, TypeError) as exc:
                    result["invalid"] = str(exc)
                    metrics["raw_result_valid"] = False
                result["final_metrics"] = metrics
            save(path, report)
    report["status"] = ("completed_with_errors" if any("invalid" in r for d in report["topics"].values()
                        for r in d["arms"].values()) else "completed") if finished else "pending"
    save(path, report)
    return finished


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="screening_comparison_test.json")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--max-wait-minutes", type=int, default=325)
    args = parser.parse_args()
    path = Path(args.output)
    if args.resume:
        report = json.loads(path.read_text())
        if report.get("experiment") != "luna-terra-2026-11-16" or report.get("test") is not True:
            raise ValueError("Wrong checkpoint")
    else:
        if path.exists():
            raise ValueError("Output already exists; use --resume")
        report = prepare(load_config(Path(__file__).resolve().parents[1] / "automation_config.json"))
        save(path, report)
    client = OpenAIBatchClient()
    deadline = time.monotonic() + args.max_wait_minutes * 60
    while True:
        if advance(client, path, report):
            print(report["status"], flush=True)
            return 0 if report["status"] == "completed" else 1
        if time.monotonic() >= deadline:
            print("Saved pending Batch IDs; resume this artifact without resubmitting", flush=True)
            return 0
        time.sleep(60)


if __name__ == "__main__":
    raise SystemExit(main())
