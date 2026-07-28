#!/usr/bin/env python3
"""GitHub Actions向けPubMed自動選定・Drive配信パイプライン。"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from automation_core import (
    TERMINAL_RUN_STATES,
    assert_lightweight_ledger,
    canonical_json,
    choose_final_candidates,
    content_hash,
    due_topic_names,
    dump_jsonl,
    edat_window,
    extract_response_json,
    final_batch_line,
    iso_z,
    load_config,
    new_ledger,
    parse_jsonl,
    render_archive_doc,
    render_notebook_doc,
    safe_drive_name,
    screen_batch_lines,
    search_by_name,
    validate_final_result,
)
from automation_services import GoogleWorkspaceClient, OpenAIBatchClient
from pubmed_fetch import fetch_abstracts, search_pubmed_edat


BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "automation_config.json"
LEDGER_NAME = "automation_ledger.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PubMed自動選定・Google Drive配信")
    parser.add_argument("command", choices=["dispatch", "poll", "retry-notification", "validate"])
    parser.add_argument("--config", default=str(CONFIG_PATH))
    parser.add_argument("--topic", action="append", help="テーマ内部名。複数指定可")
    parser.add_argument("--test", action="store_true", help="専用TEST領域で小児腎臓5件を縦切り試験")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--force", action="store_true", help="頻度判定を無視して配信対象にする")
    parser.add_argument("--run-date", help="JST日付 YYYY-MM-DD（テスト用）")
    parser.add_argument("--cycle-id", help="冪等性キー。未指定時はschedule/manual情報から生成")
    return parser.parse_args()


class DriveStore:
    def __init__(self, google: GoogleWorkspaceClient, root_id: str, test: bool):
        self.google = google
        self.base_id = google.ensure_folder(root_id, "TEST" if test else "PubMed_Automation")
        self.system_id = google.ensure_folder(self.base_id, "system")
        self.topics_id = google.ensure_folder(self.base_id, "topics")
        self.runs_id = google.ensure_folder(self.base_id, "runs")
        self.documents_id = google.ensure_folder(self.base_id, "documents")
        self.test = test
        self.ledger_file_id: str | None = None

    def load_ledger(self, config: dict[str, Any]) -> dict[str, Any]:
        found = self.google.find_child(self.system_id, LEDGER_NAME)
        if not found:
            ledger = new_ledger(config)
            uploaded = self.put_json(self.system_id, LEDGER_NAME, ledger)
            self.ledger_file_id = uploaded["id"]
            return ledger
        self.ledger_file_id = found["id"]
        ledger = json.loads(self.google.download_blob(found["id"]).decode("utf-8"))
        # 設定追加時にも既存台帳を安全に拡張する。
        baseline = new_ledger(config)
        for name, topic in baseline["topics"].items():
            ledger.setdefault("topics", {}).setdefault(name, topic)
        ledger["config_hash"] = content_hash(config)
        return ledger

    def save_ledger(self, ledger: dict[str, Any]) -> None:
        ledger["updated_at"] = iso_z()
        assert_lightweight_ledger(ledger)
        result = self.put_json(self.system_id, LEDGER_NAME, ledger, self.ledger_file_id)
        self.ledger_file_id = result["id"]

    def put_json(self, parent_id: str, name: str, value: Any, file_id: str | None = None) -> dict[str, Any]:
        content = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
        return self.google.create_or_update_blob(parent_id, name, content, "application/json", file_id)

    def put_jsonl(self, parent_id: str, name: str, lines: list[dict[str, Any]]) -> dict[str, Any]:
        return self.google.create_or_update_blob(parent_id, name, dump_jsonl(lines), "application/jsonl")

    def load_json(self, file_id: str) -> Any:
        return json.loads(self.google.download_blob(file_id).decode("utf-8"))

    def topic_folder(self, topic_name: str) -> str:
        return self.google.ensure_folder(self.topics_id, safe_drive_name(topic_name))

    def run_folder(self, cycle_id: str, topic_name: str) -> str:
        cycle_folder = self.google.ensure_folder(self.runs_id, safe_drive_name(cycle_id))
        return self.google.ensure_folder(cycle_folder, safe_drive_name(topic_name))

    def document_folders(self, topic_name: str) -> dict[str, str]:
        topic = self.google.ensure_folder(self.documents_id, safe_drive_name(topic_name))
        return {
            "archive": self.google.ensure_folder(topic, "archive"),
            "history": self.google.ensure_folder(topic, "notebooklm_history"),
            "current": self.google.ensure_folder(topic, "current"),
        }

    def save_manifest(self, manifest: dict[str, Any]) -> None:
        manifest["updated_at"] = iso_z()
        result = self.put_json(
            manifest["run_folder_id"],
            "run_manifest.json",
            manifest,
            manifest.get("manifest_file_id"),
        )
        manifest["manifest_file_id"] = result["id"]
        # 初回はmanifest自身のIDを書き込むためもう一度更新する。
        if manifest.get("_manifest_id_persisted") is not True:
            manifest["_manifest_id_persisted"] = True
            self.put_json(manifest["run_folder_id"], "run_manifest.json", manifest, result["id"])


def load_topic_index(store: DriveStore, ledger: dict[str, Any], topic_name: str) -> dict[str, Any]:
    entry = ledger["topics"][topic_name]
    if entry.get("pmid_index_file_id"):
        return store.load_json(entry["pmid_index_file_id"])
    return {"schema_version": 1, "topic": topic_name, "updated_at": iso_z(), "papers": {}}


def save_topic_index(store: DriveStore, ledger: dict[str, Any], topic_name: str, index: dict[str, Any]) -> None:
    index["updated_at"] = iso_z()
    topic_folder = store.topic_folder(topic_name)
    existing_id = ledger["topics"][topic_name].get("pmid_index_file_id")
    result = store.put_json(topic_folder, "pmid_index.json", index, existing_id)
    ledger["topics"][topic_name]["pmid_index_file_id"] = result["id"]


def run_date_from_args(args: argparse.Namespace) -> date:
    return (
        date.fromisoformat(args.run_date)
        if args.run_date
        else datetime.now(ZoneInfo("Asia/Tokyo")).date()
    )


def cycle_id_from_args(args: argparse.Namespace, run_date: date) -> str:
    if args.cycle_id:
        return args.cycle_id
    github_id = os.environ.get("GITHUB_RUN_ID")
    if args.test:
        return f"test-{github_id or run_date.isoformat()}"
    if os.environ.get("GITHUB_EVENT_NAME") == "schedule":
        return f"scheduled-{run_date.isoformat()}"
    return f"manual-{github_id or datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"


def fetch_articles_for_pmids(pmids: list[str], config: dict[str, Any]) -> list[dict[str, Any]]:
    articles = []
    page_size = 200
    for offset in range(0, len(pmids), page_size):
        articles.extend(fetch_abstracts(pmids[offset:offset + page_size]))
        if offset + page_size < len(pmids):
            time.sleep(config["pubmed"]["request_interval_seconds"])
    by_pmid = {item["pmid"]: item for item in articles}
    return [by_pmid[pmid] for pmid in pmids if pmid in by_pmid]


def scan_topic(
    store: DriveStore,
    ledger: dict[str, Any],
    topic_name: str,
    today: date,
    config: dict[str, Any],
    limit: int | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    entry = ledger["topics"][topic_name]
    index = load_topic_index(store, ledger, topic_name)
    start, end = edat_window(entry.get("last_success_edat"), today, config)
    search = search_by_name(topic_name)
    pmids, total = search_pubmed_edat(
        search["query"],
        start.isoformat(),
        end.isoformat(),
        page_size=config["pubmed"]["page_size"],
        max_records=config["pubmed"]["max_records_per_topic"],
        request_interval=config["pubmed"]["request_interval_seconds"],
    )
    new_pmids = [pmid for pmid in pmids if pmid not in index["papers"]]
    if limit is not None:
        new_pmids = new_pmids[:limit]
    articles = fetch_articles_for_pmids(new_pmids, config)
    scan_folder = store.google.ensure_folder(store.topic_folder(topic_name), "raw_scans")
    raw_ref = None
    if articles:
        raw_payload = {
            "topic": topic_name,
            "edat_start": start.isoformat(),
            "edat_end": end.isoformat(),
            "pubmed_total": total,
            "articles": articles,
        }
        raw_hash = content_hash(raw_payload)
        raw_name = f"raw_{today.isoformat()}_{raw_hash[:12]}.json"
        raw_ref = store.put_json(scan_folder, raw_name, raw_payload)
        for article in articles:
            index["papers"][article["pmid"]] = {
                "pmid": article["pmid"],
                "first_seen_at": iso_z(),
                "raw_file_id": raw_ref["id"],
                "raw_sha256": raw_hash,
                "run_id": None,
                "delivery_state": "PENDING",
            }
    entry["last_success_edat"] = end.isoformat()
    entry["component_states"]["last_scan"] = {
        "state": "COMPLETED",
        "at": iso_z(),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "pubmed_total": total,
        "new_count": len(articles),
        "raw_file_id": raw_ref["id"] if raw_ref else None,
    }
    save_topic_index(store, ledger, topic_name, index)
    store.save_ledger(ledger)
    return index, articles


def pending_articles(store: DriveStore, index: dict[str, Any], limit: int | None) -> list[dict[str, Any]]:
    pending = [item for item in index["papers"].values() if item["delivery_state"] != "DELIVERED"]
    pending.sort(key=lambda item: (item["first_seen_at"], item["pmid"]))
    if limit is not None:
        pending = pending[:limit]
    raw_ids = list(dict.fromkeys(item["raw_file_id"] for item in pending))
    article_by_pmid = {}
    for raw_id in raw_ids:
        raw = store.load_json(raw_id)
        article_by_pmid.update({item["pmid"]: item for item in raw["articles"]})
    return [article_by_pmid[item["pmid"]] for item in pending if item["pmid"] in article_by_pmid]


def submit_batch(
    openai: OpenAIBatchClient,
    store: DriveStore,
    manifest: dict[str, Any],
    stage: str,
    lines: list[dict[str, Any]],
    config: dict[str, Any],
    retry_number: int = 0,
) -> None:
    suffix = f"_retry{retry_number}" if retry_number else ""
    name = f"{stage}_batch_input{suffix}.jsonl"
    input_bytes = dump_jsonl(lines)
    drive_file = store.google.create_or_update_blob(
        manifest["run_folder_id"], name, input_bytes, "application/jsonl"
    )
    uploaded = openai.upload_jsonl(name, input_bytes)
    batch = openai.create_batch(
        uploaded["id"],
        config["batch"]["completion_window"],
        {"run_id": manifest["run_id"], "stage": stage, "retry": str(retry_number)},
    )
    component = manifest["components"][stage]
    component.setdefault("attempts", []).append({
        "number": retry_number,
        "state": "SUBMITTED",
        "input_drive_file_id": drive_file["id"],
        "input_sha256": content_hash(lines),
        "openai_input_file_id": uploaded["id"],
        "batch_id": batch["id"],
        "submitted_at": iso_z(),
        "custom_ids": [line["custom_id"] for line in lines],
    })
    component["state"] = "SUBMITTED"
    store.save_manifest(manifest)


def new_manifest(
    store: DriveStore,
    cycle_id: str,
    topic_name: str,
    display_name: str,
    articles: list[dict[str, Any]],
    test: bool,
) -> dict[str, Any]:
    run_id = f"{cycle_id}:{topic_name}"
    run_folder = store.run_folder(cycle_id, topic_name)
    raw_payload = {"run_id": run_id, "topic": topic_name, "articles": articles}
    raw_ref = store.put_json(run_folder, "all_abstracts.json", raw_payload)
    return {
        "schema_version": 1,
        "run_id": run_id,
        "cycle_id": cycle_id,
        "topic": topic_name,
        "display_name": display_name,
        "test": test,
        "state": "SCREEN_BATCH_PENDING",
        "created_at": iso_z(),
        "updated_at": iso_z(),
        "run_folder_id": run_folder,
        "manifest_file_id": None,
        "content_hash": content_hash(raw_payload),
        "article_count": len(articles),
        "article_pmids": [item["pmid"] for item in articles],
        "artifacts": {
            "all_abstracts": {"file_id": raw_ref["id"], "sha256": content_hash(raw_payload)}
        },
        "components": {
            "screen": {"state": "PENDING", "attempts": []},
            "final": {"state": "PENDING", "attempts": []},
            "archive_doc": {"state": "PENDING", "file_id": None, "attempts": 0},
            "notebook_history_doc": {"state": "PENDING", "file_id": None, "attempts": 0},
            "current_doc": {"state": "PENDING", "attempts": 0},
        },
        "failed_pmids": [],
    }


def command_dispatch(args: argparse.Namespace, config: dict[str, Any], store: DriveStore, ledger: dict[str, Any]) -> None:
    today = run_date_from_args(args)
    cycle_id = cycle_id_from_args(args, today)

    all_names = list(config["topics"])
    if args.test:
        scan_names = ["ped_nephrology_update"]
        due_names = scan_names
        limit = args.limit or 5
    else:
        scan_names = all_names
        requested = set(args.topic or [])
        due_names = due_topic_names(config, today, force=args.force)
        if requested:
            unknown = requested - set(all_names)
            if unknown:
                raise ValueError(f"不明なテーマ: {sorted(unknown)}")
            due_names = [name for name in due_names if name in requested]
            scan_names = sorted(requested)
        limit = args.limit

    cycle = ledger["cycles"].get(cycle_id)
    if cycle and cycle["state"] != "DISPATCHING":
        print(f"既存cycleを検出したため重複dispatchを行いません: {cycle_id}")
        return
    if not cycle:
        cycle = {
            "cycle_id": cycle_id,
            "created_at": iso_z(),
            "test": args.test,
            "state": "DISPATCHING",
            "scans": {},
            "topics": {},
            "notification": {"state": "PENDING", "attempts": 0, "message_id": None},
        }
        ledger["cycles"][cycle_id] = cycle
        store.save_ledger(ledger)
    cycle.setdefault("scans", {})

    indexes = {}
    for name in scan_names:
        if cycle["scans"].get(name, {}).get("state") == "COMPLETED":
            index = load_topic_index(store, ledger, name)
        else:
            index, _ = scan_topic(store, ledger, name, today, config, limit if args.test else None)
            cycle["scans"][name] = {"state": "COMPLETED", "at": iso_z()}
            store.save_ledger(ledger)
        indexes[name] = index

    openai = OpenAIBatchClient()
    for name in due_names:
        if name in cycle["topics"]:
            continue
        recovered_folder = store.run_folder(cycle_id, name)
        recovered_ref = store.google.find_child(recovered_folder, "run_manifest.json")
        if recovered_ref:
            manifest = store.load_json(recovered_ref["id"])
            if not manifest["components"]["screen"]["attempts"]:
                raw = store.load_json(manifest["artifacts"]["all_abstracts"]["file_id"])
                lines = screen_batch_lines(manifest["run_id"], raw["articles"], config)
                submit_batch(openai, store, manifest, "screen", lines, config)
            cycle["topics"][name] = {
                "state": "RUNNING",
                "run_manifest_file_id": manifest["manifest_file_id"],
                "run_id": manifest["run_id"],
            }
            ledger["topics"][name]["last_run_manifest_file_id"] = manifest["manifest_file_id"]
            store.save_ledger(ledger)
            continue
        index = indexes.get(name) or load_topic_index(store, ledger, name)
        articles = pending_articles(store, index, limit)
        if not articles:
            cycle["topics"][name] = {"state": "EMPTY", "run_manifest_file_id": None}
            continue
        manifest = new_manifest(
            store, cycle_id, name, config["topics"][name]["display_name"], articles, args.test
        )
        store.save_manifest(manifest)
        lines = screen_batch_lines(manifest["run_id"], articles, config)
        submit_batch(openai, store, manifest, "screen", lines, config)
        cycle["topics"][name] = {
            "state": "RUNNING",
            "run_manifest_file_id": manifest["manifest_file_id"],
            "run_id": manifest["run_id"],
        }
        ledger["topics"][name]["last_run_manifest_file_id"] = manifest["manifest_file_id"]
        for pmid in manifest["article_pmids"]:
            index["papers"][pmid]["run_id"] = manifest["run_id"]
            index["papers"][pmid]["delivery_state"] = "PROCESSING"
        save_topic_index(store, ledger, name, index)
        store.save_ledger(ledger)

    cycle["state"] = "RUNNING" if any(item["state"] == "RUNNING" for item in cycle["topics"].values()) else "COMPLETED_EMPTY"
    if cycle["state"] == "COMPLETED_EMPTY":
        cycle["notification"]["state"] = "NOT_REQUIRED"
    store.save_ledger(ledger)
    print(f"dispatch完了: {cycle_id}, 配信run={sum(v['state'] == 'RUNNING' for v in cycle['topics'].values())}")


def load_attempt_outputs(
    openai: OpenAIBatchClient,
    store: DriveStore,
    manifest: dict[str, Any],
    stage: str,
    attempt: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    successes: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    if attempt.get("output_drive_file_id"):
        successes = parse_jsonl(store.google.download_blob(attempt["output_drive_file_id"]).decode("utf-8"))
    elif attempt.get("output_file_id"):
        raw = openai.download_file(attempt["output_file_id"])
        ref = store.google.create_or_update_blob(
            manifest["run_folder_id"],
            f"{stage}_batch_output_{attempt['number']}.jsonl",
            raw,
            "application/jsonl",
        )
        attempt["output_drive_file_id"] = ref["id"]
        attempt["output_sha256"] = content_hash(parse_jsonl(raw.decode("utf-8")))
        successes = parse_jsonl(raw.decode("utf-8"))
    if attempt.get("error_drive_file_id"):
        errors = parse_jsonl(store.google.download_blob(attempt["error_drive_file_id"]).decode("utf-8"))
    elif attempt.get("error_file_id"):
        raw = openai.download_file(attempt["error_file_id"])
        ref = store.google.create_or_update_blob(
            manifest["run_folder_id"],
            f"{stage}_batch_errors_{attempt['number']}.jsonl",
            raw,
            "application/jsonl",
        )
        attempt["error_drive_file_id"] = ref["id"]
        attempt["error_sha256"] = content_hash(parse_jsonl(raw.decode("utf-8")))
        errors = parse_jsonl(raw.decode("utf-8"))
    return successes, errors


def poll_batch_stage(
    openai: OpenAIBatchClient,
    store: DriveStore,
    manifest: dict[str, Any],
    stage: str,
    config: dict[str, Any],
) -> bool:
    component = manifest["components"][stage]
    if component["state"] == "COMPLETED":
        return True
    attempt = component["attempts"][-1]
    batch = openai.retrieve_batch(attempt["batch_id"])
    attempt["state"] = batch["status"].upper()
    attempt["output_file_id"] = batch.get("output_file_id")
    attempt["error_file_id"] = batch.get("error_file_id")
    if batch["status"] not in {"completed", "failed", "expired", "cancelled"}:
        store.save_manifest(manifest)
        return False

    successes, errors = load_attempt_outputs(openai, store, manifest, stage, attempt)
    def valid_success(line: dict[str, Any]) -> bool:
        if line.get("response", {}).get("status_code") != 200:
            return False
        try:
            extract_response_json(line)
            return True
        except Exception:
            return False

    success_ids = {line.get("custom_id") for line in successes if valid_success(line)}
    expected_ids = set(attempt["custom_ids"])
    failed_ids = expected_ids - success_ids
    failed_ids.update(line.get("custom_id") for line in errors if line.get("custom_id"))
    all_successes = []
    for prior in component["attempts"]:
        prior_successes, _ = load_attempt_outputs(openai, store, manifest, stage, prior)
        all_successes.extend(
            line for line in prior_successes if valid_success(line)
        )
    success_by_id = {line["custom_id"]: line for line in all_successes}
    remaining = [custom_id for custom_id in failed_ids if custom_id not in success_by_id]

    if remaining and attempt["number"] < config["batch"]["max_partial_retries"]:
        original = parse_jsonl(
            store.google.download_blob(attempt["input_drive_file_id"]).decode("utf-8")
        )
        retry_lines = [line for line in original if line["custom_id"] in set(remaining)]
        submit_batch(
            openai, store, manifest, stage, retry_lines, config, retry_number=attempt["number"] + 1
        )
        return False

    result_ref = store.put_json(
        manifest["run_folder_id"],
        f"{stage}_successful_responses.json",
        list(success_by_id.values()),
    )
    component["result_file_id"] = result_ref["id"]
    input_tokens = cached_input_tokens = output_tokens = total_tokens = 0
    for line in success_by_id.values():
        usage = line.get("response", {}).get("body", {}).get("usage", {})
        input_tokens += usage.get("input_tokens", 0) or 0
        cached_input_tokens += (
            usage.get("input_tokens_details", {}).get("cached_tokens", 0) or 0
        )
        output_tokens += usage.get("output_tokens", 0) or 0
        total_tokens += usage.get("total_tokens", 0) or 0
    prices = config["models"][stage]
    estimated_cost = None
    if all(
        prices.get(key) is not None
        for key in (
            "input_usd_per_million",
            "cached_input_usd_per_million",
            "output_usd_per_million",
        )
    ):
        # Batch APIは通常料金から割引されるため、設定値にはBatch適用後単価を入れる。
        estimated_cost = (
            (input_tokens - cached_input_tokens) * prices["input_usd_per_million"]
            + cached_input_tokens * prices["cached_input_usd_per_million"]
            + output_tokens * prices["output_usd_per_million"]
        ) / 1_000_000
    component["usage"] = {
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens or input_tokens + output_tokens,
        "estimated_cost_usd": estimated_cost,
    }
    component["failed_custom_ids"] = remaining
    component["state"] = "COMPLETED" if success_by_id else "FAILED"
    store.save_manifest(manifest)
    return component["state"] == "COMPLETED"


def process_screen_result(
    openai: OpenAIBatchClient,
    store: DriveStore,
    manifest: dict[str, Any],
    config: dict[str, Any],
) -> None:
    component = manifest["components"]["screen"]
    lines = store.load_json(component["result_file_id"])
    scores = []
    parse_failures = []
    for line in lines:
        try:
            scores.append(extract_response_json(line))
        except Exception:
            parse_failures.append(line.get("custom_id", "?"))
    score_ref = store.put_json(manifest["run_folder_id"], "screen_evaluations.json", scores)
    manifest["artifacts"]["screen_evaluations"] = {
        "file_id": score_ref["id"], "sha256": content_hash(scores)
    }
    failed_ids = component.get("failed_custom_ids", []) + parse_failures
    manifest["failed_pmids"] = sorted({
        custom_id.rsplit(":", 1)[-1] for custom_id in failed_ids
    })
    candidates = choose_final_candidates(scores, config)
    candidate_ref = store.put_json(manifest["run_folder_id"], "final_candidates.json", candidates)
    manifest["artifacts"]["final_candidates"] = {
        "file_id": candidate_ref["id"], "sha256": content_hash(candidates)
    }
    if not candidates:
        manifest["state"] = "FAILED"
        manifest["failure_reason"] = "一次評価の成功結果がありません。"
        store.save_manifest(manifest)
        return
    raw = store.load_json(manifest["artifacts"]["all_abstracts"]["file_id"])
    line = final_batch_line(
        manifest["run_id"], manifest["display_name"], candidates, raw["articles"], config
    )
    submit_batch(openai, store, manifest, "final", [line], config)
    manifest["state"] = "FINAL_BATCH_SUBMITTED"
    store.save_manifest(manifest)


def create_documents(
    store: DriveStore,
    ledger: dict[str, Any],
    manifest: dict[str, Any],
    config: dict[str, Any],
) -> None:
    raw = store.load_json(manifest["artifacts"]["all_abstracts"]["file_id"])
    scores = store.load_json(manifest["artifacts"]["screen_evaluations"]["file_id"])
    final = store.load_json(manifest["artifacts"]["final_evaluation"]["file_id"])
    folders = store.document_folders(manifest["topic"])
    prefix = "[TEST] " if manifest["test"] else ""
    stamp = manifest["cycle_id"]
    archive_text = render_archive_doc(
        manifest["display_name"], manifest["run_id"], raw["articles"], scores, final
    )
    notebook_text = render_notebook_doc(
        manifest["display_name"], manifest["run_id"], raw["articles"], final
    )

    archive_component = manifest["components"]["archive_doc"]
    if not archive_component.get("file_id"):
        doc = store.google.create_doc(
            folders["archive"],
            f"{prefix}{manifest['display_name']}_{stamp}_全件アーカイブ",
            archive_text,
        )
        archive_component.update({
            "state": "COMPLETED",
            "file_id": doc["id"],
            "url": doc["webViewLink"],
            "sha256": content_hash(archive_text),
        })
        store.save_manifest(manifest)

    history_component = manifest["components"]["notebook_history_doc"]
    if not history_component.get("file_id"):
        doc = store.google.create_doc(
            folders["history"],
            f"{prefix}{manifest['display_name']}_{stamp}_NotebookLM",
            notebook_text,
        )
        history_component.update({
            "state": "COMPLETED",
            "file_id": doc["id"],
            "url": doc["webViewLink"],
            "sha256": content_hash(notebook_text),
        })
        store.save_manifest(manifest)

    current_component = manifest["components"]["current_doc"]
    topic_ledger = ledger["topics"][manifest["topic"]]
    try:
        current_id = topic_ledger.get("current_file_id")
        if not current_id:
            doc = store.google.create_doc(
                folders["current"],
                config["topics"][manifest["topic"]]["current_name"],
                notebook_text,
            )
            current_id = doc["id"]
            topic_ledger["current_file_id"] = current_id
        else:
            store.google.replace_doc_text(current_id, notebook_text)
        # 縦切りでは同一内容でもう一度更新し、ID不変を明示的に検証する。
        if manifest["test"]:
            before_id = current_id
            store.google.replace_doc_text(current_id, notebook_text)
            if current_id != before_id:
                raise RuntimeError("CURRENTのfile IDが変化しました。")
            current_component["stability_verified"] = True
        current_file = store.google.get_file(current_id)
        current_component.update({
            "state": "COMPLETED",
            "file_id": current_id,
            "url": current_file.get("webViewLink") or f"https://docs.google.com/document/d/{current_id}/edit",
            "sha256": content_hash(notebook_text),
        })
    except Exception as exc:
        current_component["attempts"] = current_component.get("attempts", 0) + 1
        current_component["state"] = "CURRENT_UPDATE_PENDING"
        current_component["last_error"] = str(exc)
    store.save_manifest(manifest)
    store.save_ledger(ledger)


def retry_current_if_needed(
    store: DriveStore,
    ledger: dict[str, Any],
    manifest: dict[str, Any],
    config: dict[str, Any],
) -> None:
    component = manifest["components"]["current_doc"]
    if component["state"] != "CURRENT_UPDATE_PENDING":
        return
    if component["attempts"] >= config["retry"]["component_max_attempts"]:
        component["state"] = "FAILED_RETRYABLE"
        return
    final = store.load_json(manifest["artifacts"]["final_evaluation"]["file_id"])
    raw = store.load_json(manifest["artifacts"]["all_abstracts"]["file_id"])
    text = render_notebook_doc(manifest["display_name"], manifest["run_id"], raw["articles"], final)
    topic_ledger = ledger["topics"][manifest["topic"]]
    try:
        current_id = topic_ledger.get("current_file_id")
        if not current_id:
            folders = store.document_folders(manifest["topic"])
            doc = store.google.create_doc(
                folders["current"], config["topics"][manifest["topic"]]["current_name"], text
            )
            current_id = doc["id"]
            topic_ledger["current_file_id"] = current_id
        else:
            store.google.replace_doc_text(current_id, text)
        component.update({
            "state": "COMPLETED",
            "file_id": current_id,
            "url": f"https://docs.google.com/document/d/{current_id}/edit",
            "sha256": content_hash(text),
        })
    except Exception as exc:
        component["attempts"] += 1
        component["last_error"] = str(exc)
    store.save_manifest(manifest)
    store.save_ledger(ledger)


def finish_run(
    store: DriveStore,
    ledger: dict[str, Any],
    manifest: dict[str, Any],
) -> None:
    current_state = manifest["components"]["current_doc"]["state"]
    if current_state == "CURRENT_UPDATE_PENDING":
        return
    warning = current_state != "COMPLETED" or bool(manifest["failed_pmids"])
    manifest["state"] = "COMPLETED_WITH_WARNINGS" if warning else "COMPLETED"
    index = load_topic_index(store, ledger, manifest["topic"])
    failed = set(manifest["failed_pmids"])
    for pmid in manifest["article_pmids"]:
        paper = index["papers"].get(pmid)
        if not paper:
            continue
        if pmid in failed:
            paper["delivery_state"] = "PENDING"
        else:
            paper["delivery_state"] = "DELIVERED"
            paper["delivered_at"] = iso_z()
            paper["run_id"] = manifest["run_id"]
    save_topic_index(store, ledger, manifest["topic"], index)
    topic_ledger = ledger["topics"][manifest["topic"]]
    topic_ledger["last_run_manifest_file_id"] = manifest["manifest_file_id"]
    topic_ledger["component_states"] = {
        "run": manifest["state"],
        "archive_doc": manifest["components"]["archive_doc"]["state"],
        "notebook_history_doc": manifest["components"]["notebook_history_doc"]["state"],
        "current_doc": current_state,
    }
    store.save_manifest(manifest)
    store.save_ledger(ledger)


def poll_manifest(
    openai: OpenAIBatchClient,
    store: DriveStore,
    ledger: dict[str, Any],
    manifest: dict[str, Any],
    config: dict[str, Any],
) -> None:
    if manifest["state"] in TERMINAL_RUN_STATES:
        return
    if manifest["components"]["screen"]["state"] != "COMPLETED":
        completed = poll_batch_stage(openai, store, manifest, "screen", config)
        if not completed:
            if manifest["components"]["screen"]["state"] == "FAILED":
                manifest["state"] = "FAILED"
                manifest["failure_reason"] = "一次Batchが全件失敗しました。"
                store.save_manifest(manifest)
            return
    if not manifest["components"]["final"]["attempts"]:
        process_screen_result(openai, store, manifest, config)
        return
    if manifest["components"]["final"]["state"] != "COMPLETED":
        completed = poll_batch_stage(openai, store, manifest, "final", config)
        if not completed:
            if manifest["components"]["final"]["state"] == "FAILED":
                manifest["state"] = "FAILED"
                manifest["failure_reason"] = "最終Batchが失敗しました。"
                store.save_manifest(manifest)
            return
        lines = store.load_json(manifest["components"]["final"]["result_file_id"])
        if not lines:
            manifest["state"] = "FAILED"
            manifest["failure_reason"] = "最終Batch結果が空です。"
            store.save_manifest(manifest)
            return
        final = extract_response_json(lines[0])
        candidates = store.load_json(manifest["artifacts"]["final_candidates"]["file_id"])
        try:
            validate_final_result(
                final,
                {item["pmid"] for item in candidates},
                config["selection"]["selected_n"],
                config["selection"]["alternate_n"],
            )
        except ValueError as exc:
            attempts = manifest["components"]["final"]["attempts"]
            last_attempt = attempts[-1]
            if last_attempt["number"] < config["batch"]["max_partial_retries"]:
                retry_lines = parse_jsonl(
                    store.google.download_blob(last_attempt["input_drive_file_id"]).decode("utf-8")
                )
                submit_batch(
                    openai,
                    store,
                    manifest,
                    "final",
                    retry_lines,
                    config,
                    retry_number=last_attempt["number"] + 1,
                )
                manifest["state"] = "FINAL_BATCH_RESUBMITTED"
            else:
                manifest["components"]["final"]["state"] = "FAILED"
                manifest["state"] = "FAILED"
                manifest["failure_reason"] = f"最終結果の検証に失敗しました: {exc}"
            store.save_manifest(manifest)
            return
        final_ref = store.put_json(manifest["run_folder_id"], "final_evaluation.json", final)
        manifest["artifacts"]["final_evaluation"] = {
            "file_id": final_ref["id"], "sha256": content_hash(final)
        }
        manifest["selected_count"] = len(final["selected"])
        manifest["alternate_count"] = len(final["alternates"])
        store.save_manifest(manifest)
    if manifest["components"]["notebook_history_doc"]["state"] != "COMPLETED":
        try:
            create_documents(store, ledger, manifest, config)
        except Exception as exc:
            for name in ("archive_doc", "notebook_history_doc"):
                component = manifest["components"][name]
                if component["state"] != "COMPLETED":
                    component["attempts"] = component.get("attempts", 0) + 1
                    component["state"] = "RETRY_PENDING"
                    component["last_error"] = str(exc)
                    if component["attempts"] >= config["retry"]["component_max_attempts"]:
                        component["state"] = "FAILED"
                        manifest["state"] = "FAILED"
                        manifest["failure_reason"] = f"{name}の作成に繰り返し失敗しました。"
                    break
            store.save_manifest(manifest)
            return
        if manifest["components"]["current_doc"]["state"] == "CURRENT_UPDATE_PENDING":
            return
    retry_current_if_needed(store, ledger, manifest, config)
    finish_run(store, ledger, manifest)


def digest_body(cycle: dict[str, Any], manifests: list[dict[str, Any]]) -> str:
    lines = [
        f"PubMed自動選定が完了しました。",
        f"処理回: {cycle['cycle_id']}",
        "",
    ]
    for manifest in manifests:
        final_count = 0
        final_ref = manifest.get("artifacts", {}).get("final_evaluation", {}).get("file_id")
        if final_ref:
            final_count = manifest.get("selected_count", "?")
        lines.extend([
            f"■ {manifest['display_name']}",
            f"状態: {manifest['state']}",
            f"新着: {manifest['article_count']}件 / 選定: {final_count}件",
            f"全件アーカイブ: {manifest['components']['archive_doc'].get('url', '未作成')}",
            f"NotebookLM履歴: {manifest['components']['notebook_history_doc'].get('url', '未作成')}",
            f"CURRENT: {manifest['components']['current_doc'].get('url', manifest['components']['current_doc']['state'])}",
            f"評価失敗PMID: {', '.join(manifest.get('failed_pmids', [])) or 'なし'}",
            "API使用量: "
            + ", ".join(
                f"{stage}={manifest['components'].get(stage, {}).get('usage', {}).get('total_tokens', 0)} tokens"
                for stage in ("screen", "final")
            ),
            "推定費用: "
            + (
                f"${sum(manifest['components'][stage].get('usage', {}).get('estimated_cost_usd') or 0 for stage in ('screen', 'final')):.4f}"
                if all(
                    manifest["components"].get(stage, {}).get("usage", {}).get("estimated_cost_usd") is not None
                    for stage in ("screen", "final")
                )
                else "単価未設定（トークン数を参照）"
            ),
            "",
        ])
    failed = [m["display_name"] for m in manifests if m["state"] == "FAILED"]
    current_failed = [
        m["display_name"] for m in manifests
        if m["components"]["current_doc"]["state"] != "COMPLETED"
    ]
    lines.extend([
        f"失敗テーマ: {', '.join(failed) or 'なし'}",
        f"CURRENT更新未完了: {', '.join(current_failed) or 'なし'}",
        f"通知試行回数: {cycle['notification']['attempts'] + 1}",
    ])
    return "\n".join(lines)


def maybe_notify(
    store: DriveStore,
    ledger: dict[str, Any],
    cycle: dict[str, Any],
    manifests: list[dict[str, Any]],
    config: dict[str, Any],
    force: bool = False,
) -> None:
    notification = cycle["notification"]
    if notification["state"] == "SENT":
        return
    if not manifests:
        notification["state"] = "NOT_REQUIRED"
        return
    if any(manifest["state"] not in TERMINAL_RUN_STATES for manifest in manifests):
        return
    if not force and notification["attempts"] >= config["retry"]["notification_max_attempts"]:
        notification["state"] = "NOTIFICATION_FAILED_RETRYABLE"
        return
    subject = f"{'[TEST] ' if cycle['test'] else ''}PubMed最新論文ダイジェスト {cycle['cycle_id']}"
    body = digest_body(cycle, manifests)
    notification["attempts"] += 1
    try:
        recipient = os.environ.get("GMAIL_NOTIFY_TO", "").strip()
        if not recipient:
            raise RuntimeError("GMAIL_NOTIFY_TOが設定されていません。")
        result = store.google.send_email(
            recipient,
            subject,
            body,
            deterministic_message_id=content_hash({"cycle_id": cycle["cycle_id"]})[:32],
        )
        notification.update({"state": "SENT", "message_id": result["id"], "sent_at": iso_z()})
    except Exception as exc:
        notification.update({
            "state": "NOTIFICATION_FAILED_RETRYABLE",
            "last_error": str(exc),
            "last_attempt_at": iso_z(),
        })
    store.save_ledger(ledger)


def command_poll(
    args: argparse.Namespace,
    config: dict[str, Any],
    store: DriveStore,
    ledger: dict[str, Any],
    notification_only: bool = False,
) -> None:
    openai = None if notification_only else OpenAIBatchClient()
    selected_cycles = [
        cycle for cycle_id, cycle in ledger["cycles"].items()
        if (not args.cycle_id or cycle_id == args.cycle_id)
        and cycle["state"] not in {"COMPLETED_EMPTY", "DISPATCHING"}
    ]
    for cycle in selected_cycles:
        manifests = []
        for topic_name, topic_state in cycle["topics"].items():
            manifest_id = topic_state.get("run_manifest_file_id")
            if not manifest_id:
                continue
            manifest = store.load_json(manifest_id)
            if not notification_only:
                poll_manifest(openai, store, ledger, manifest, config)
                manifest = store.load_json(manifest_id)
            manifests.append(manifest)
            topic_state["state"] = manifest["state"]
        if manifests and all(item["state"] in TERMINAL_RUN_STATES for item in manifests):
            cycle["state"] = (
                "COMPLETED_WITH_WARNINGS"
                if any(item["state"] != "COMPLETED" for item in manifests)
                else "COMPLETED"
            )
        store.save_ledger(ledger)
        maybe_notify(store, ledger, cycle, manifests, config, force=notification_only)
    print(f"poll完了: {len(selected_cycles)} cycle")


def main() -> int:
    args = parse_args()
    config = load_config(args.config)
    if args.command == "validate":
        print(f"設定OK: {len(config['topics'])}テーマ, hash={content_hash(config)}")
        return 0
    root_id = os.environ.get("GOOGLE_DRIVE_ROOT_FOLDER_ID", "").strip()
    if not root_id:
        raise RuntimeError("GOOGLE_DRIVE_ROOT_FOLDER_IDが設定されていません。")
    google = GoogleWorkspaceClient()
    store = DriveStore(google, root_id, args.test)
    ledger = store.load_ledger(config)
    if args.command == "dispatch":
        command_dispatch(args, config, store, ledger)
    elif args.command == "poll":
        command_poll(args, config, store, ledger)
    else:
        command_poll(args, config, store, ledger, notification_only=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
