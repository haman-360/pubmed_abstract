"""Shared deterministic display values for Docs and the review ledger. No I/O."""
from typing import Any
import re

SCORE_TABLE_HEADERS = ["PMID", "タイトル", "総合スコア", "役立つか", "短いメモ"]

def _clinic_usefulness_label(score: dict[str, Any]) -> str:
    value = score.get("outpatient_usefulness")
    if not isinstance(value, int):
        return "未評価"
    if value >= 4:
        return f"Yes ({value}/5)"
    if value == 3:
        return f"要検討 ({value}/5)"
    return f"No ({value}/5)"


def _score_table_cell(value: Any) -> str:
    """Keep the plain-text transport format to exactly one physical table cell."""
    return re.sub(r"\s+", " ", str(value)).strip().replace("|", "｜")

def candidate_score_rows(articles, scores):
    by_pmid = {str(score["pmid"]): score for score in scores}
    rows = []
    for article in articles:
        score = by_pmid.get(str(article["pmid"]), {})
        rows.append([_score_table_cell(value) for value in [
            article["pmid"], article.get("title", ""), score.get("total_score", "未評価"),
            _clinic_usefulness_label(score),
            score.get("one_line_assessment", "一次評価を取得できませんでした"),
        ]])
    return rows
