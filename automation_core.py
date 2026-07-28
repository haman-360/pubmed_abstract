#!/usr/bin/env python3
"""PubMed自動配信の副作用を持たない中核ロジック。"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from pubmed_fetch import SEARCHES


TERMINAL_RUN_STATES = {"COMPLETED", "COMPLETED_WITH_WARNINGS", "FAILED"}
SCREEN_RESCUE_TYPES = {
    "guideline",
    "practice guideline",
    "systematic review",
    "meta-analysis",
    "randomized controlled trial",
    "rct",
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_z(value: datetime | None = None) -> str:
    return (value or utc_now()).astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def load_config(path: str | Path) -> dict[str, Any]:
    with open(path, encoding="utf-8") as handle:
        config = json.load(handle)
    validate_config(config)
    return config


def validate_config(config: dict[str, Any]) -> None:
    search_names = {item["name"] for item in SEARCHES}
    topic_names = set(config["topics"])
    missing = search_names - topic_names
    extra = topic_names - search_names
    if missing or extra:
        raise ValueError(f"テーマ対応が不一致です。missing={sorted(missing)}, extra={sorted(extra)}")
    if len(topic_names) != 14:
        raise ValueError("automation_config.jsonには14テーマが必要です。")
    for name, topic in config["topics"].items():
        if topic["frequency"] not in {"weekly", "biweekly", "monthly"}:
            raise ValueError(f"{name}: 未対応のfrequencyです。")
        if not topic["display_name"] or not topic["current_name"]:
            raise ValueError(f"{name}: 表示名とCURRENT名が必要です。")
    selection = config["selection"]
    if selection["base_candidate_n"] + selection["rescue_max"] > selection["final_candidate_max"]:
        raise ValueError("候補上限の設定が矛盾しています。")
    if selection["selected_n"] + selection["alternate_n"] > selection["final_candidate_max"]:
        raise ValueError("最終選定＋次点が最終候補上限を超えています。")


def search_by_name(name: str) -> dict[str, Any]:
    return next(item for item in SEARCHES if item["name"] == name)


def is_due(frequency: str, run_date: date, anchor: date) -> bool:
    if frequency == "weekly":
        return True
    if frequency == "biweekly":
        return (run_date - anchor).days % 14 == 0
    if frequency == "monthly":
        return run_date.weekday() == 5 and run_date.day <= 7
    raise ValueError(f"未対応のfrequency: {frequency}")


def due_topic_names(config: dict[str, Any], run_date: date, force: bool = False) -> list[str]:
    anchor = date.fromisoformat(config["schedule"]["biweekly_anchor"])
    return [
        name
        for name, topic in config["topics"].items()
        if force or is_due(topic["frequency"], run_date, anchor)
    ]


def edat_window(last_success_edat: str | None, today: date, config: dict[str, Any]) -> tuple[date, date]:
    pubmed = config["pubmed"]
    if last_success_edat:
        start = date.fromisoformat(last_success_edat) - timedelta(days=pubmed["edat_overlap_days"])
    else:
        start = today - timedelta(days=pubmed["initial_lookback_days"])
    return start, today


def compact_article(article: dict[str, Any], abstract_limit: int = 8000) -> dict[str, Any]:
    result = {
        key: article.get(key, "")
        for key in ("pmid", "title", "journal", "year", "month", "author", "publication_types")
    }
    abstract = article.get("abstract", "")
    result["abstract"] = abstract[:abstract_limit] + ("…" if len(abstract) > abstract_limit else "")
    return result


def screen_schema() -> dict[str, Any]:
    properties = {
        "pmid": {"type": "string"},
        "title": {"type": "string"},
        "publication_type": {"type": "string"},
        "study_design": {"type": "string"},
        "estimated_sample_size": {"type": ["integer", "null"], "minimum": 0},
        "is_guideline": {"type": "boolean"},
        "is_systematic_review": {"type": "boolean"},
        "is_meta_analysis": {"type": "boolean"},
        "is_rct": {"type": "boolean"},
        "is_large_study": {"type": "boolean"},
        "outpatient_usefulness": {"type": "integer", "minimum": 0, "maximum": 5},
        "practice_change": {"type": "integer", "minimum": 0, "maximum": 5},
        "evidence_strength": {"type": "integer", "minimum": 0, "maximum": 5},
        "pediatric_directness": {"type": "integer", "minimum": 0, "maximum": 5},
        "novelty": {"type": "integer", "minimum": 0, "maximum": 5},
        "total_score": {"type": "integer", "minimum": 0, "maximum": 25},
        "one_line_assessment": {"type": "string"},
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(properties),
    }


def final_item_schema(max_rank: int) -> dict[str, Any]:
    properties = {
        "rank": {"type": "integer", "minimum": 1, "maximum": max_rank},
        "pmid": {"type": "string"},
        "title": {"type": "string"},
        "score": {"type": "integer", "minimum": 0, "maximum": 25},
        "study_design": {"type": "string"},
        "japanese_summary": {"type": "string"},
        "why_important": {"type": "string"},
        "clinical_impact": {"type": "string"},
        "limitations": {"type": "string"},
        "practice_change_needed": {"type": "string"},
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(properties),
    }


def final_schema(selected_n: int, alternate_n: int, candidate_count: int) -> dict[str, Any]:
    selected_max = min(selected_n, candidate_count)
    alternate_max = min(alternate_n, max(0, candidate_count - selected_max))
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "selection_summary": {"type": "string"},
            "selected": {
                "type": "array",
                "minItems": 0,
                "maxItems": selected_max,
                "items": final_item_schema(max(1, selected_max)),
            },
            "alternates": {
                "type": "array",
                "minItems": 0,
                "maxItems": alternate_max,
                "items": final_item_schema(max(1, selected_max + alternate_max)),
            },
        },
        "required": ["selection_summary", "selected", "alternates"],
    }


SCREEN_INSTRUCTIONS = """あなたは小児外来向け医学文献の一次評価者です。
入力は1論文です。PMIDとタイトルを正確に転記し、抄録から判断できない事項は推測しすぎないでください。
ガイドライン、システマティックレビュー、メタ解析、RCT、大規模研究、診療変更可能性を明示し、
外来有用性・診療変更・エビデンス・小児直接性・新規性を各0〜5点、合計0〜25点で評価してください。
is_large_studyは推定症例数1,000以上のときtrueです。"""


FINAL_INSTRUCTIONS = """あなたは日本の外来小児科医向け医学文献キュレーターです。
候補だけから重要論文と次点を別配列で選び、入力のPMIDを正確に転記してください。
selectedは診療への直接性とエビデンスを重視して順位付けし、alternatesと重複させないでください。
日本語要約はNotebookLMの音声解説に適した簡潔で具体的な文章にしてください。
診療判断ではなく文献キュレーションであり、限界と診療変更の必要性を明記してください。"""


def response_body(model: str, effort: str, instructions: str, payload: Any, name: str, schema: dict[str, Any]) -> dict[str, Any]:
    return {
        "model": model,
        "reasoning": {"effort": effort},
        "instructions": instructions,
        "input": json.dumps(payload, ensure_ascii=False),
        "text": {
            "format": {
                "type": "json_schema",
                "name": name,
                "strict": True,
                "schema": schema,
            }
        },
    }


def screen_batch_lines(run_id: str, articles: Iterable[dict[str, Any]], config: dict[str, Any]) -> list[dict[str, Any]]:
    model = config["models"]["screen"]
    lines = []
    for article in articles:
        lines.append({
            "custom_id": f"{run_id}:screen:{article['pmid']}",
            "method": "POST",
            "url": "/v1/responses",
            "body": response_body(
                model["name"], model["reasoning_effort"], SCREEN_INSTRUCTIONS,
                {"article": compact_article(article)}, "pubmed_screen_score", screen_schema(),
            ),
        })
    return lines


def _rescue_class(score: dict[str, Any]) -> int:
    if score.get("is_guideline"):
        return 5
    if score.get("is_systematic_review") or score.get("is_meta_analysis"):
        return 4
    if score.get("is_rct"):
        return 3
    if (score.get("estimated_sample_size") or 0) >= 1000 or score.get("is_large_study"):
        return 2
    if score.get("practice_change", 0) >= 4 and score.get("outpatient_usefulness", 0) >= 4:
        return 1
    return 0


def score_sort_key(score: dict[str, Any]) -> tuple[Any, ...]:
    return (
        score.get("total_score", 0),
        score.get("practice_change", 0),
        score.get("outpatient_usefulness", 0),
        score.get("evidence_strength", 0),
        score.get("pediatric_directness", 0),
        score.get("pmid", ""),
    )


def choose_final_candidates(scores: list[dict[str, Any]], config: dict[str, Any]) -> list[dict[str, Any]]:
    selection = config["selection"]
    ranked = sorted(scores, key=score_sort_key, reverse=True)
    base = ranked[:selection["base_candidate_n"]]
    base_pmids = {item["pmid"] for item in base}
    rescue = [item for item in ranked[selection["base_candidate_n"]:] if _rescue_class(item)]
    rescue.sort(
        key=lambda item: (
            _rescue_class(item),
            item.get("evidence_strength", 0),
            item.get("practice_change", 0),
            item.get("total_score", 0),
            item.get("pmid", ""),
        ),
        reverse=True,
    )
    chosen = base + [item for item in rescue if item["pmid"] not in base_pmids][:selection["rescue_max"]]
    return chosen[:selection["final_candidate_max"]]


def final_batch_line(
    run_id: str,
    theme: str,
    candidates: list[dict[str, Any]],
    articles: list[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    model = config["models"]["final"]
    article_by_pmid = {item["pmid"]: item for item in articles}
    selected_n = config["selection"]["selected_n"]
    alternate_n = config["selection"]["alternate_n"]
    payload = {
        "theme": theme,
        "candidate_scores": candidates,
        "candidate_articles": [compact_article(article_by_pmid[item["pmid"]]) for item in candidates],
        "selected_n": min(selected_n, len(candidates)),
        "alternate_n": min(alternate_n, max(0, len(candidates) - selected_n)),
    }
    return {
        "custom_id": f"{run_id}:final",
        "method": "POST",
        "url": "/v1/responses",
        "body": response_body(
            model["name"], model["reasoning_effort"], FINAL_INSTRUCTIONS, payload,
            "pubmed_final_selection", final_schema(selected_n, alternate_n, len(candidates)),
        ),
    }


def extract_response_json(batch_line: dict[str, Any]) -> dict[str, Any]:
    response = batch_line.get("response", {}).get("body", {})
    text = response.get("output_text")
    if not text:
        chunks = []
        for item in response.get("output", []):
            for content in item.get("content", []):
                if content.get("type") in {"output_text", "text"}:
                    chunks.append(content.get("text", ""))
        text = "".join(chunks)
    if not text:
        raise ValueError(f"Batch応答にoutput textがありません: {batch_line.get('custom_id')}")
    return json.loads(text)


def parse_jsonl(text: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def dump_jsonl(lines: Iterable[dict[str, Any]]) -> bytes:
    return ("\n".join(canonical_json(line) for line in lines) + "\n").encode("utf-8")


def validate_final_result(result: dict[str, Any], candidate_pmids: set[str], selected_n: int, alternate_n: int) -> None:
    selected = result.get("selected", [])
    alternates = result.get("alternates", [])
    if len(selected) > min(selected_n, len(candidate_pmids)):
        raise ValueError("最終選定が上限を超えています。")
    if len(alternates) > min(alternate_n, max(0, len(candidate_pmids) - len(selected))):
        raise ValueError("次点が上限または候補件数を超えています。")
    pmids = [item["pmid"] for item in selected + alternates]
    if len(pmids) != len(set(pmids)) or not set(pmids).issubset(candidate_pmids):
        raise ValueError("最終結果に重複または候補外PMIDがあります。")


def _paper_lookup(articles: list[dict[str, Any]], scores: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    return (
        {item["pmid"]: item for item in articles},
        {item["pmid"]: item for item in scores},
    )


def render_archive_doc(theme: str, run_id: str, articles: list[dict[str, Any]], scores: list[dict[str, Any]], final: dict[str, Any]) -> str:
    article_by_pmid, score_by_pmid = _paper_lookup(articles, scores)
    selected = {item["pmid"]: item for item in final.get("selected", [])}
    alternates = {item["pmid"]: item for item in final.get("alternates", [])}
    lines = [f"{theme} PubMed全件アーカイブ", f"Run ID: {run_id}", "", "選定区分: 最終選定／次点／その他", ""]
    for index, article in enumerate(articles, 1):
        pmid = article["pmid"]
        status = "最終選定" if pmid in selected else "次点" if pmid in alternates else "その他"
        score = score_by_pmid.get(pmid, {})
        lines.extend([
            f"{index}. [{status}] {article['title']}",
            f"PMID: {pmid}  https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            f"雑誌: {article.get('journal', '?')} ({article.get('year', '?')}/{article.get('month', '')})",
            f"研究デザイン: {score.get('study_design', '不明')} / Publication type: {score.get('publication_type', '不明')}",
            "スコア: " + ", ".join(
                f"{key}={score.get(key, '-')}" for key in (
                    "total_score", "outpatient_usefulness", "practice_change",
                    "evidence_strength", "pediatric_directness", "novelty",
                )
            ),
            f"一行評価: {score.get('one_line_assessment', '評価未取得')}",
            "Abstract:",
            article.get("abstract", "(abstract not available)"),
            "", "────────────────────", "",
        ])
    return "\n".join(lines)


def render_notebook_doc(theme: str, run_id: str, articles: list[dict[str, Any]], final: dict[str, Any]) -> str:
    article_by_pmid = {item["pmid"]: item for item in articles}
    lines = [
        f"{theme} NotebookLM用厳選文献",
        f"Run ID: {run_id}",
        f"選定数: {len(final.get('selected', []))}",
        "",
        final.get("selection_summary", ""),
        "",
    ]
    for item in final.get("selected", []):
        article = article_by_pmid[item["pmid"]]
        lines.extend([
            f"{item['rank']}. {item['title']}",
            f"PMID: {item['pmid']}  https://pubmed.ncbi.nlm.nih.gov/{item['pmid']}/",
            f"雑誌: {article.get('journal', '?')} ({article.get('year', '?')}/{article.get('month', '')})",
            f"研究デザイン: {item['study_design']}",
            f"日本語要約: {item['japanese_summary']}",
            f"重要性: {item['why_important']}",
            f"臨床影響: {item['clinical_impact']}",
            f"限界: {item['limitations']}",
            f"診療変更の必要性: {item['practice_change_needed']}",
            "", "────────────────────", "",
        ])
    return "\n".join(lines)


def new_ledger(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "config_hash": content_hash(config),
        "updated_at": iso_z(),
        "topics": {
            name: {
                "last_success_edat": None,
                "current_file_id": None,
                "pmid_index_file_id": None,
                "last_run_manifest_file_id": None,
                "component_states": {},
            }
            for name in config["topics"]
        },
        "cycles": {},
    }


def assert_lightweight_ledger(ledger: dict[str, Any]) -> None:
    forbidden = {"abstract", "batch_raw_output", "screen_evaluations", "final_evaluation"}

    def walk(value: Any, path: str = "") -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key.lower() in forbidden:
                    raise ValueError(f"軽量台帳に禁止フィールドがあります: {path}/{key}")
                walk(child, f"{path}/{key}")
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, f"{path}/{index}")
        elif isinstance(value, str) and len(value) > 2000:
            raise ValueError(f"軽量台帳に長大な文字列があります: {path}")

    walk(ledger)


def safe_drive_name(value: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "_", value).strip() or "pubmed"
