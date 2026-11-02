"""Turn a frozen missed-PMID list into complete, resumable ten-paper editions."""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

from automation_core import content_hash, iso_z, new_ledger, screen_batch_lines
from pubmed_automation import (
    DriveStore, fetch_articles_for_pmids, new_manifest, submit_batch,
)


def load_report(path):
    """Read only report data, never execute prose or instructions in an attachment."""
    path = Path(path)
    text = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() == ".json":
        report = json.loads(text)
        ranked = report["ranked"]
        end = date.fromisoformat(report["period"]["end"])
    else:
        # The report's ranked table, not arbitrary digits in titles/score columns.
        pmids = re.findall(r"(?m)^\|\s*\d+\s*\|\s*\[([1-9][0-9]{0,8})\]\(https://pubmed\.ncbi\.nlm\.nih\.gov/\1/\)", text)
        ranked = [{"pmid": pmid} for pmid in pmids]
        match = re.search(r"\d{4}-\d{2}-\d{2}", path.name)
        if not match:
            raise ValueError("Markdownのファイル名には検索日 YYYY-MM-DD が必要です。")
        end = date.fromisoformat(match[0])
    validate_ranked(ranked)
    return ranked, end


def validate_ranked(ranked):
    pmids = [item["pmid"] for item in ranked]
    if (not pmids or any(not isinstance(p, str) or not re.fullmatch(r"[1-9][0-9]{0,8}", p) for p in pmids)
            or len(set(pmids)) != len(pmids)):
        raise ValueError("読み忘れ候補には、重複のない有効なPMIDが1件以上必要です。")
    return pmids


def load_drive_report(google, root_id, end, required=True):
    """Reuse the exact saved monthly result; do not rerun the ranking/search."""
    parent = root_id
    for name in ("PubMed_Automation", "missed_papers", f"{end.isoformat()}_missed_pmids.json"):
        found = google.find_child(parent, name)
        if not found:
            if not required:
                return None
            raise ValueError("保存済み読み忘れレポートが見つかりません: " + name)
        parent = found["id"]
    report = json.loads(google.download_blob(parent).decode("utf-8"))
    if report["period"]["end"] != end.isoformat():
        raise ValueError("保存済みレポートの検索日が一致しません。")
    if report["ranked"]:
        validate_ranked(report["ranked"])
    return report["ranked"]


def dispatch_missed_editions(google, openai, root_id, ranked, end, config, batch_size=10, test=False):
    """Persist source/manifest before submission; ordinary poll/recovery owns the rest."""
    pmids = validate_ranked(ranked)
    if not 1 <= batch_size <= 10:
        raise ValueError("1文書の論文数は1〜10件にしてください。")
    store = DriveStore(google, root_id, test)
    ledger = store.load_ledger(config)
    cycle_id = f"{'test-' if test else ''}missed-{end.isoformat()}"
    identity = content_hash({"pmids": pmids, "batch_size": batch_size})
    cycle = ledger["cycles"].get(cycle_id)
    if cycle:
        if cycle.get("source_hash") != identity:
            raise ValueError("同じ検索日の配信が別のPMID集合または分割数で存在します。上書きしません。")
        if cycle["state"] != "DISPATCHING":
            return cycle_id
    else:
        cycle = dict(cycle_id=cycle_id, created_at=iso_z(), test=test, state="DISPATCHING",
                     delivery_mode="all", source_hash=identity, topics={},
                     notification={"state": "PENDING", "attempts": 0, "message_id": None})
        ledger["cycles"][cycle_id] = cycle
        store.save_ledger(ledger)

    # Freeze both the exact PMID order and the search's original ranking evidence.
    source_folder = google.ensure_folder(store.runs_id, cycle_id)
    source_ref = google.find_child(source_folder, "missed_source.json")
    if source_ref:
        frozen = store.load_json(source_ref["id"])
        ranked = frozen["ranked"]
        if validate_ranked(ranked) != pmids:
            raise ValueError("保存済み読み忘れ候補と入力が一致しません。")
    else:
        store.put_json(source_folder, "missed_source.json", {"ranked": ranked, "batch_size": batch_size})

    count = (len(pmids) + batch_size - 1) // batch_size
    for number, offset in enumerate(range(0, len(pmids), batch_size), 1):
        topic = f"missed_papers_{number:02d}"
        ledger["topics"].setdefault(topic, new_ledger({"topics": {topic: {}}})["topics"][topic])
        folder = store.run_folder(cycle_id, topic)
        existing = google.find_child(folder, "run_manifest.json")
        if existing:
            manifest = store.load_json(existing["id"])
            articles = store.load_json(manifest["artifacts"]["all_abstracts"]["file_id"])["articles"]
        else:
            group = pmids[offset:offset + batch_size]
            articles = fetch_articles_for_pmids(group, config)
            if [a["pmid"] for a in articles] != group:
                raise ValueError("PubMed書誌の取得に欠落があります。同じ入力で再実行してください。")
            manifest = new_manifest(store, cycle_id, topic, f"読み忘れ候補 {number:02d}（全{count}分冊）",
                                    articles, test, end)
            manifest.update(delivery_mode="all", missed_source_hash=identity)
            store.save_manifest(manifest)
        cycle["topics"][topic] = dict(state=manifest["state"], run_manifest_file_id=manifest["manifest_file_id"],
                                    run_id=manifest["run_id"])
        ledger["topics"][topic]["last_run_manifest_file_id"] = manifest["manifest_file_id"]
        store.save_ledger(ledger)
        if not manifest["components"]["screen"]["attempts"]:
            lines = screen_batch_lines(manifest["run_id"], articles, config, include_all=True)
            submit_batch(openai, store, manifest, "screen", lines, config)
        cycle["topics"][topic]["state"] = "RUNNING"
        store.save_ledger(ledger)
    cycle["state"] = "RUNNING"
    store.save_ledger(ledger)
    return cycle_id
