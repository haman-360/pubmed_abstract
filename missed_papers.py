#!/usr/bin/env python3
"""過去の見逃し候補を、既知PMIDとの差分と論文単位の指標から抽出する。"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from pubmed_fetch import fetch_abstracts, search_pubmed_date_range


ICITE_URL = "https://icite.od.nih.gov/api/pubs"
GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
PMID_PATTERNS = (
    re.compile(r"(?i)\bPMID\s*[:：#]?\s*(\d{1,9})\b"),
    re.compile(r"https?://pubmed\.ncbi\.nlm\.nih\.gov/(\d{1,9})/?", re.I),
    re.compile(r'''(?i)["']pmid["']\s*:\s*["']?(\d{1,9})'''),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="読み忘れた可能性がある重要論文のPMID候補を抽出")
    parser.add_argument("--days", type=int, default=365, help="振り返る発行日の日数（初回は730を推奨）")
    parser.add_argument("--end-date", help="検索終了日 YYYY-MM-DD（既定: 今日）")
    parser.add_argument("--top", type=int, help="出力する候補数")
    parser.add_argument("--config", default="missed_papers_config.json")
    parser.add_argument("--output", help="Markdown出力先")
    parser.add_argument("--known-file", action="append", default=[], help="既知PMIDを含む追加ファイル")
    parser.add_argument("--known-only", action="store_true", help="既知PMIDデータベースの更新だけを行う")
    parser.add_argument("--known-db", default="missed_papers/known_pmids.json", help="既知PMIDデータベース出力先")
    parser.add_argument("--include-drive", action="store_true", help="既存Google Drive正本からPMIDを抽出")
    parser.add_argument(
        "--include-drive-docs",
        action="store_true",
        help="Drive正本に加えて、権限内のGoogle Docs本文も初回抽出する（時間がかかる）",
    )
    parser.add_argument("--drive-root", help="DriveルートID（未指定なら環境変数）")
    parser.add_argument("--authorized-user-file", default="google_authorized_user.json")
    parser.add_argument("--no-icite", action="store_true", help="引用指標を取得せず研究デザインだけで順位付け")
    parser.add_argument("--max-records-per-query", type=int, default=10000)
    parser.add_argument("--request-interval", type=float, default=0.4)
    parser.add_argument(
        "--publish",
        action="store_true",
        help="結果Markdown/JSONをDriveへ保存し、GmailでPMID一覧を通知",
    )
    return parser.parse_args()


def extract_pmids(text: str) -> set[str]:
    found: set[str] = set()
    for pattern in PMID_PATTERNS:
        found.update(pattern.findall(text))
    return found


def read_text_file(path: str | Path) -> str:
    return Path(path).read_text(encoding="utf-8", errors="ignore")


def collect_local_known(config: dict[str, Any], extra_files: Iterable[str]) -> tuple[set[str], dict[str, int]]:
    known: set[str] = set()
    counts: dict[str, int] = {}
    paths: list[str] = []
    for pattern in config.get("known_local_globs", []):
        paths.extend(glob.glob(pattern, recursive=True))
    paths.extend(extra_files)
    for path in dict.fromkeys(paths):
        if not Path(path).is_file():
            continue
        text = read_text_file(path)
        pmids = extract_pmids(text)
        if Path(path).suffix.casefold() == ".json":
            try:
                payload = json.loads(text)
                if isinstance(payload, dict) and isinstance(payload.get("pmids"), list):
                    pmids.update(
                        str(value) for value in payload["pmids"] if str(value).isdigit()
                    )
            except json.JSONDecodeError:
                pass
        known.update(pmids)
        counts[path] = len(pmids)
    return known, counts


def _authorized_user_json(path: str) -> str:
    raw = os.environ.get("GOOGLE_AUTHORIZED_USER_JSON", "")
    if raw:
        return raw
    if Path(path).is_file():
        return Path(path).read_text(encoding="utf-8")
    raise RuntimeError("Google認証情報がありません。環境変数または--authorized-user-fileを指定してください。")


def collect_drive_known(
    authorized_user_json: str,
    include_docs: bool = False,
) -> tuple[set[str], dict[str, int]]:
    """drive.fileで見えるPMID台帳とGoogle Docsから既知PMIDを集める。"""
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    info = json.loads(authorized_user_json)
    credentials = Credentials.from_authorized_user_info(
        info, scopes=["https://www.googleapis.com/auth/drive.file"]
    )
    drive = build("drive", "v3", credentials=credentials, cache_discovery=False)
    known: set[str] = set()
    counts: dict[str, int] = {}
    # drive.file自体がこのアプリで作成・明示的に開いたファイルだけに制限する。
    # 日常実行は正本台帳だけ、初回だけ必要に応じてGoogle Docs本文も直接検索する。
    target_clause = "name = 'pmid_index.json'"
    if include_docs:
        target_clause += f" or mimeType = '{GOOGLE_DOC_MIME}'"
    page_token = None
    while True:
        result = drive.files().list(
            q=(
                f"trashed = false and ({target_clause})"
            ),
            fields="nextPageToken,files(id,name,mimeType)",
            pageSize=1000,
            pageToken=page_token,
        ).execute()
        for item in result.get("files", []):
            mime = item.get("mimeType", "")
            try:
                if mime == GOOGLE_DOC_MIME:
                    raw = drive.files().export(
                        fileId=item["id"], mimeType="text/plain"
                    ).execute()
                else:
                    raw = drive.files().get_media(fileId=item["id"]).execute()
                text = raw.decode("utf-8", errors="ignore") if isinstance(raw, bytes) else str(raw)
            except Exception as exc:
                print(f"警告: Driveファイルを読めませんでした: {item['name']}: {exc}")
                continue
            pmids = extract_pmids(text)
            known.update(pmids)
            counts[f"Drive:{item['name']}"] = counts.get(f"Drive:{item['name']}", 0) + len(pmids)
        page_token = result.get("nextPageToken")
        if not page_token:
            break
    return known, counts


def fetch_icite(pmids: list[str], request_interval: float = 0.2) -> tuple[dict[str, dict[str, Any]], list[str]]:
    metrics: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    for offset in range(0, len(pmids), 200):
        chunk = pmids[offset:offset + 200]
        url = f"{ICITE_URL}?{urllib.parse.urlencode({'pmids': ','.join(chunk)})}"
        request = urllib.request.Request(url, headers={"User-Agent": "pubmed-missed-papers/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
            for item in payload.get("data", []):
                metrics[str(item.get("pmid"))] = item
        except Exception as exc:
            warnings.append(f"iCite取得失敗（{offset + 1}-{offset + len(chunk)}件目）: {exc}")
        if offset + 200 < len(pmids):
            time.sleep(request_interval)
    return metrics, warnings


def fetch_details(pmids: list[str], request_interval: float) -> dict[str, dict[str, Any]]:
    articles: list[dict[str, Any]] = []
    for offset in range(0, len(pmids), 200):
        articles.extend(fetch_abstracts(pmids[offset:offset + 200]))
        if offset + 200 < len(pmids):
            time.sleep(request_interval)
    return {item["pmid"]: item for item in articles}


def number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def preliminary_score(pmid: str, sources: set[str], metrics: dict[str, dict[str, Any]]) -> float:
    item = metrics.get(pmid, {})
    citations = number(item.get("citation_count"))
    per_year = number(item.get("citations_per_year"))
    percentile = number(item.get("nih_percentile"))
    signal = 18.0 if "umbrella_signal" in sources else 0.0
    topic_bonus = min(10.0, 4.0 * len(sources - {"umbrella_signal"}))
    return signal + topic_bonus + min(20.0, 5.0 * math.log2(1 + citations)) + min(
        15.0, 5.0 * math.log2(1 + per_year)
    ) + min(15.0, percentile * 0.15)


DESIGN_POINTS = {
    "guideline": 35,
    "practice guideline": 35,
    "meta-analysis": 28,
    "systematic review": 24,
    "randomized controlled trial": 22,
    "multicenter study": 12,
    "clinical trial": 10,
    "review": 6,
}


def rank_candidate(
    pmid: str,
    sources: set[str],
    metrics: dict[str, dict[str, Any]],
    details: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    metric = metrics.get(pmid, {})
    article = details.get(pmid, {})
    types = [str(item) for item in article.get("publication_types", [])]
    normalized = {item.casefold() for item in types}
    design_score = max((points for name, points in DESIGN_POINTS.items() if name in normalized), default=0)
    base = preliminary_score(pmid, sources, metrics)
    score = round(base + design_score, 2)
    citations = int(number(metric.get("citation_count")))
    per_year = number(metric.get("citations_per_year"))
    reasons = []
    if types:
        reasons.append("/".join(types[:3]))
    if citations:
        reasons.append(f"引用{citations}件（年換算{per_year:.1f}）")
    topic_names = sorted(sources - {"umbrella_signal"})
    if topic_names:
        reasons.append("領域=" + ",".join(topic_names))
    if "umbrella_signal" in sources:
        reasons.append("小児高エビデンス検索")
    return {
        "pmid": pmid,
        "score": score,
        "title": article.get("title") or metric.get("title") or "",
        "journal": article.get("journal") or metric.get("journal") or "",
        "year": article.get("year") or metric.get("year") or "",
        "citation_count": citations,
        "citations_per_year": round(per_year, 2),
        "publication_types": types,
        "topics": topic_names,
        "reason": " / ".join(reasons) or "領域検索に一致",
    }


def render_report(
    ranked: list[dict[str, Any]],
    start: date,
    end: date,
    known_count: int,
    candidate_count: int,
    warnings: list[str],
) -> str:
    lines = [
        "# 読み忘れ候補PMID",
        "",
        f"検索期間（発行日）: {start.isoformat()}〜{end.isoformat()}",
        f"既知PMID: {known_count}件 / 差分候補: {candidate_count}件 / 出力: {len(ranked)}件",
        "",
        "この順位は雑誌Impact Factorではなく、論文単位の引用、発行後時間、研究デザイン、領域一致を用いた再検索順位です。新しい論文は引用が少ないため、ガイドライン・メタ解析・RCT等を別に加点しています。",
        "",
        "## PMID（コピー用）",
        "",
        ", ".join(item["pmid"] for item in ranked) or "該当なし",
        "",
        "## 確認用一覧",
        "",
        "|順位|PMID|スコア|引用|タイトル|候補理由|",
        "|---:|---:|---:|---:|---|---|",
    ]
    for index, item in enumerate(ranked, 1):
        title = item["title"].replace("|", "｜").replace("\n", " ")
        reason = item["reason"].replace("|", "｜").replace("\n", " ")
        url = f"https://pubmed.ncbi.nlm.nih.gov/{item['pmid']}/"
        lines.append(
            f"|{index}|[{item['pmid']}]({url})|{item['score']:.2f}|{item['citation_count']}|{title}|{reason}|"
        )
    if warnings:
        lines.extend(["", "## 警告", ""] + [f"- {warning}" for warning in warnings])
    return "\n".join(lines) + "\n"


def publish_report(
    output: str,
    report: str,
    ranked: list[dict[str, Any]],
    authorized_user_json: str,
    root_id: str,
    end: date,
) -> None:
    from automation_services import GoogleWorkspaceClient

    google = GoogleWorkspaceClient(authorized_user_json)
    base = google.ensure_folder(root_id, "PubMed_Automation")
    folder = google.ensure_folder(base, "missed_papers")
    markdown_path = Path(output)
    json_path = markdown_path.with_suffix(".json")
    markdown_file = google.create_or_update_blob(
        folder, markdown_path.name, markdown_path.read_bytes(), "text/markdown"
    )
    google.create_or_update_blob(
        folder, json_path.name, json_path.read_bytes(), "application/json"
    )
    recipient = os.environ.get("GMAIL_NOTIFY_TO", "").strip()
    if not recipient:
        raise RuntimeError("--publishにはGMAIL_NOTIFY_TOが必要です。")
    pmid_line = ", ".join(item["pmid"] for item in ranked) or "該当なし"
    body = "\n".join([
        "過去論文の見逃し再検索が完了しました。",
        "",
        f"候補PMID（{len(ranked)}件）:",
        pmid_line,
        "",
        "確認用レポート:",
        markdown_file.get("webViewLink", "DriveのPubMed_Automation/missed_papersを確認してください。"),
        "",
        "雑誌Impact Factorではなく、論文単位の引用・研究デザイン・領域一致による順位です。",
    ])
    google.send_email(
        recipient,
        f"PubMed 読み忘れ候補PMID {end.isoformat()}",
        body,
        deterministic_message_id=f"missed-papers-{end.isoformat()}",
    )


def main() -> int:
    args = parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    end = date.fromisoformat(args.end_date) if args.end_date else date.today()
    if args.days <= 0:
        raise ValueError("--daysは1以上にしてください。")
    start = end - timedelta(days=args.days - 1)
    output_n = args.top or config["ranking"]["default_output_n"]

    known, source_counts = collect_local_known(config, args.known_file)
    if args.include_drive or args.include_drive_docs:
        drive_known, drive_counts = collect_drive_known(
            _authorized_user_json(args.authorized_user_file),
            include_docs=args.include_drive_docs,
        )
        known.update(drive_known)
        source_counts.update(drive_counts)

    known_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "pmid_count": len(known),
        "pmids": sorted(known, key=lambda value: int(value)),
        "source_counts": source_counts,
    }
    Path(args.known_db).parent.mkdir(parents=True, exist_ok=True)
    Path(args.known_db).write_text(
        json.dumps(known_payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"既知PMIDデータベース: {args.known_db}（{len(known)}件）", flush=True)
    if args.known_only:
        return 0

    candidate_sources: dict[str, set[str]] = defaultdict(set)
    queries = {"umbrella_signal": config["umbrella_signal_query"], **config["topics"]}
    for name, query in queries.items():
        pmids, total = search_pubmed_date_range(
            query,
            start,
            end,
            datetype="pdat",
            max_records=args.max_records_per_query,
            request_interval=args.request_interval,
        )
        print(f"{name}: {total}件", flush=True)
        for pmid in pmids:
            if pmid not in known:
                candidate_sources[pmid].add(name)
        # NCBI API keyなしの上限（毎秒3リクエスト）を超えないよう、
        # ページが1枚だけの検索同士にも間隔を置く。
        if args.request_interval > 0:
            time.sleep(args.request_interval)

    candidate_pmids = list(candidate_sources)
    metrics: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    if not args.no_icite and candidate_pmids:
        metrics, warnings = fetch_icite(candidate_pmids)
    prelim = sorted(
        candidate_pmids,
        key=lambda pmid: (preliminary_score(pmid, candidate_sources[pmid], metrics), pmid),
        reverse=True,
    )
    pool_size = max(output_n * 3, int(config["ranking"]["detail_pool_size"]))
    detail_pmids = prelim[:pool_size]
    details = fetch_details(detail_pmids, args.request_interval)
    ranked = sorted(
        (
            rank_candidate(pmid, candidate_sources[pmid], metrics, details)
            for pmid in detail_pmids
        ),
        key=lambda item: (item["score"], item["citation_count"], item["pmid"]),
        reverse=True,
    )[:output_n]

    output = args.output or f"missed_papers/{end.isoformat()}_missed_pmids.md"
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    report = render_report(ranked, start, end, len(known), len(candidate_pmids), warnings)
    Path(output).write_text(report, encoding="utf-8")
    audit = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "known_pmid_count": len(known),
        "known_source_counts": source_counts,
        "candidate_count": len(candidate_pmids),
        "ranked": ranked,
        "warnings": warnings,
    }
    Path(output).with_suffix(".json").write_text(
        json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    if args.publish:
        root_id = args.drive_root or os.environ.get("GOOGLE_DRIVE_ROOT_FOLDER_ID", "")
        if not root_id:
            raise RuntimeError("--publishにはGOOGLE_DRIVE_ROOT_FOLDER_IDが必要です。")
        publish_report(
            output,
            report,
            ranked,
            _authorized_user_json(args.authorized_user_file),
            root_id,
            end,
        )
    print(f"出力: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
