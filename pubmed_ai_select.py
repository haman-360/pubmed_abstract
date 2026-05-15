#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PubMed AI Selector
==================
PubMed検索結果から、外来小児科医にとって重要な論文10本をAIで選定し、
日本語評価と英語abstract集を1つのHTMLにまとめます。
"""

import argparse
import html
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime

from pubmed_fetch import (
    REQUEST_INTERVAL,
    fetch_abstracts,
    safe_filename,
    search_pubmed,
    select_searches,
)


OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
DEFAULT_SCREEN_MODEL = "gpt-5.4-mini"
DEFAULT_FINAL_MODEL = "gpt-5.5"


def load_dotenv(path):
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


def parse_args():
    parser = argparse.ArgumentParser(
        description="PubMed検索結果をOpenAI APIでスコアリングし、重要論文10本の統合HTMLを作成します。"
    )
    parser.add_argument("--frequency", choices=["all", "monthly", "weekly"], default="all")
    parser.add_argument("--topic", action="append", help="例: --topic asthma / --topic constipation / --topic 小児感染症")
    parser.add_argument("--retmax", type=int, default=100, help="各テーマでPubMedから取得する最大件数")
    parser.add_argument("--top-n", type=int, default=10, help="最終的に選ぶ論文数")
    parser.add_argument("--candidate-n", type=int, default=20, help="最終評価に回す候補数")
    parser.add_argument("--screen-model", default=DEFAULT_SCREEN_MODEL, help="一次スコアリング用モデル")
    parser.add_argument("--final-model", default=DEFAULT_FINAL_MODEL, help="最終選定・要約用モデル")
    parser.add_argument("--screen-effort", default="low", help="一次スコアリング用reasoning effort")
    parser.add_argument("--final-effort", default="high", help="最終選定用reasoning effort")
    parser.add_argument("--output-dir", default=os.path.dirname(os.path.abspath(__file__)))
    parser.add_argument("--duplicate-extra-n", type=int, default=3, help="他テーマと重複した重要論文がある場合に追加する最大枠数")
    parser.add_argument("--selection-history", default="selected_pmids_history.json", help="選定PMID履歴ファイル")
    parser.add_argument("--dry-run", action="store_true", help="OpenAI APIを呼ばず、取得と入力データ作成だけ確認する")
    return parser.parse_args()


def openai_api_key():
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise RuntimeError(
            "OPENAI_API_KEY が設定されていません。先にOpenAI APIキーを環境変数に設定してください。"
        )
    return key


def extract_output_text(response):
    if "output_text" in response:
        return response["output_text"]

    parts = []
    for item in response.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in ("output_text", "text"):
                parts.append(content.get("text", ""))
    return "\n".join(part for part in parts if part)


def post_openai(payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        OPENAI_RESPONSES_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {openai_api_key()}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI APIエラー: HTTP {e.code}\n{detail}") from e


def call_json_model(model, effort, instructions, user_payload, schema_name, schema):
    payload = {
        "model": model,
        "reasoning": {"effort": effort},
        "input": [
            {
                "role": "system",
                "content": instructions,
            },
            {
                "role": "user",
                "content": json.dumps(user_payload, ensure_ascii=False),
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": schema_name,
                "schema": schema,
                "strict": True,
            }
        },
    }
    response = post_openai(payload)
    text = extract_output_text(response)
    if not text:
        raise RuntimeError("OpenAI APIの応答からテキストを取得できませんでした。")
    return json.loads(text)


def compact_article(article, max_abstract_chars=2600):
    abstract = article["abstract"]
    if len(abstract) > max_abstract_chars:
        abstract = abstract[:max_abstract_chars] + "..."
    return {
        "pmid": article["pmid"],
        "title": article["title"],
        "journal": article["journal"],
        "year": article["year"],
        "month": article["month"],
        "author": article["author"],
        "abstract": abstract,
    }


def article_key(article):
    return article["pmid"]


def score_schema():
    score_item = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "pmid": {"type": "string"},
            "title": {"type": "string"},
            "outpatient_usefulness": {"type": "integer", "minimum": 0, "maximum": 5},
            "practice_change": {"type": "integer", "minimum": 0, "maximum": 5},
            "evidence_strength": {"type": "integer", "minimum": 0, "maximum": 5},
            "pediatric_directness": {"type": "integer", "minimum": 0, "maximum": 5},
            "novelty": {"type": "integer", "minimum": 0, "maximum": 5},
            "total_score": {"type": "integer", "minimum": 0, "maximum": 25},
            "useful_for_clinic": {"type": "string", "enum": ["Yes", "Maybe", "No"]},
            "short_reason": {"type": "string"},
        },
        "required": [
            "pmid",
            "title",
            "outpatient_usefulness",
            "practice_change",
            "evidence_strength",
            "pediatric_directness",
            "novelty",
            "total_score",
            "useful_for_clinic",
            "short_reason",
        ],
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "scores": {"type": "array", "items": score_item},
        },
        "required": ["scores"],
    }


def final_schema(top_n, max_items):
    selected_item = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "rank": {"type": "integer", "minimum": 1, "maximum": max_items},
            "pmid": {"type": "string"},
            "title": {"type": "string"},
            "score": {"type": "integer", "minimum": 0, "maximum": 25},
            "useful_for_clinic": {"type": "string", "enum": ["Yes", "Maybe", "No"]},
            "duplicate_status": {"type": "string", "enum": ["new", "duplicate_important", "additional"]},
            "why_important": {"type": "string"},
            "clinical_impact": {"type": "string"},
            "practice_change_needed": {"type": "string"},
            "selection_reason": {"type": "string"},
        },
        "required": [
            "rank",
            "pmid",
            "title",
            "score",
            "useful_for_clinic",
            "duplicate_status",
            "why_important",
            "clinical_impact",
            "practice_change_needed",
            "selection_reason",
        ],
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "selection_summary": {"type": "string"},
            "selected": {"type": "array", "minItems": top_n, "maxItems": max_items, "items": selected_item},
        },
        "required": ["selection_summary", "selected"],
    }


def score_articles(search, articles, args):
    instructions = """
あなたは小児外来診療に詳しい医学文献レビュー担当者です。
入力されたPubMed論文を、外来小児科医が読む価値という観点で採点してください。
必ず入力に存在するPMIDだけを使い、PMIDとタイトルを正確に転記してください。
成人中心、基礎研究寄り、診療への示唆が弱い論文は低く評価してください。
ガイドライン、practice guideline、systematic review、meta-analysis、RCT、診療を変えうる安全性情報は高く評価してください。
"""
    user_payload = {
        "theme": search["label"],
        "scoring_rules": {
            "outpatient_usefulness": "外来小児科で直接役立つか 0-5",
            "practice_change": "診療変更につながるか 0-5",
            "evidence_strength": "エビデンスの強さ 0-5",
            "pediatric_directness": "小児への直接性 0-5",
            "novelty": "新規性 0-5",
        },
        "articles": [compact_article(article) for article in articles],
    }
    return call_json_model(
        args.screen_model,
        args.screen_effort,
        instructions,
        user_payload,
        "pubmed_article_scores",
        score_schema(),
    )["scores"]


def final_select(search, articles, scores, args, top_n, duplicate_pmids):
    score_by_pmid = {score["pmid"]: score for score in scores}
    ranked_pmids = [
        score["pmid"]
        for score in sorted(
            scores,
            key=lambda s: (
                s.get("total_score", 0),
                s.get("practice_change", 0),
                s.get("outpatient_usefulness", 0),
                s.get("evidence_strength", 0),
            ),
            reverse=True,
        )
    ]
    article_by_pmid = {article_key(article): article for article in articles}
    candidates = [
        article_by_pmid[pmid]
        for pmid in ranked_pmids
        if pmid in article_by_pmid
    ][: max(args.candidate_n, top_n + args.duplicate_extra_n)]
    max_items = min(len(candidates), top_n + args.duplicate_extra_n)

    instructions = """
あなたは外来小児科医向けの医学文献キュレーターです。
候補論文から、診療を変える可能性があるものだけを厳選してください。
最終選定では、スコアだけでなく、実際の外来診療への応用可能性、エビデンスの質、日本の小児外来での実用性を重視してください。
必ず入力データに含まれるPMIDだけを使い、PMIDを正確に転記してください。
duplicate_pmids は、同じ月の別テーマで既に選ばれたPMIDです。
重複論文がそのテーマでも重要なら duplicate_important として残してください。
ただし重複論文を残した場合は、可能な範囲で additional として別の非重複論文を追加し、読める新規論文数を増やしてください。
重複していない通常選定は new としてください。
除外論文の詳しい解説は不要です。出力は選定論文に集中してください。
日本語は簡潔に、NotebookLMの音声解説の材料として読みやすく書いてください。
"""
    user_payload = {
        "theme": search["label"],
        "top_n": top_n,
        "max_items": max_items,
        "duplicate_pmids": sorted(duplicate_pmids),
        "scores": [score_by_pmid.get(article["pmid"], {}) for article in candidates],
        "candidate_articles": [compact_article(article, max_abstract_chars=5000) for article in candidates],
    }
    return call_json_model(
        args.final_model,
        args.final_effort,
        instructions,
        user_payload,
        "pubmed_final_selection",
        final_schema(top_n, max_items),
    )


def html_escape(value):
    return html.escape(str(value), quote=True)


def pub_date(article):
    return f"{article['year']}/{article['month']}" if article.get("month") else article.get("year", "?")


def render_selected_summary(selected):
    rows = []
    for item in selected:
        rows.append(
            "<tr>"
            f"<td>{item['rank']}</td>"
            f"<td>{html_escape(item['pmid'])}</td>"
            f"<td>{html_escape(item['title'])}</td>"
            f"<td>{html_escape(item['score'])}</td>"
            f"<td>{html_escape(item['useful_for_clinic'])}</td>"
            f"<td>{html_escape(item.get('duplicate_status', 'new'))}</td>"
            f"<td>{html_escape(item['practice_change_needed'])}</td>"
            "</tr>"
        )
    return "\n".join(rows)


def render_japanese_blocks(selected):
    blocks = []
    for item in selected:
        blocks.append(f"""
<section class="paper">
<p class="separator">---</p>
<p><strong>{item['rank']}.</strong></p>
<p><strong>① タイトル</strong><br>{html_escape(item['title'])}</p>
<p><strong>② PMID</strong><br>{html_escape(item['pmid'])}</p>
<p><strong>③ スコア / 役立つか</strong><br>{html_escape(item['score'])}/25 / {html_escape(item['useful_for_clinic'])}</p>
<p><strong>④ 重複状態</strong><br>{html_escape(item.get('duplicate_status', 'new'))}</p>
<p><strong>⑤ なぜ重要か</strong><br>{html_escape(item['why_important'])}</p>
<p><strong>⑥ 臨床への影響</strong><br>{html_escape(item['clinical_impact'])}</p>
<p><strong>⑦ 診療変更の必要性</strong><br>{html_escape(item['practice_change_needed'])}</p>
<p><strong>選定理由</strong><br>{html_escape(item['selection_reason'])}</p>
</section>
""")
    return "\n".join(blocks)


def render_abstracts(selected, articles):
    article_by_pmid = {article["pmid"]: article for article in articles}
    blocks = []
    for item in selected:
        article = article_by_pmid.get(item["pmid"])
        if not article:
            continue
        abstract = html_escape(article["abstract"]).replace("\n", "<br>")
        blocks.append(f"""
<section class="paper">
<p class="separator">---</p>
<p><strong>{item['rank']}. {html_escape(article['title'])}</strong><br>
PMID: {html_escape(article['pmid'])}<br>
Journal: {html_escape(article['journal'])} ({html_escape(pub_date(article))})<br>
Authors: {html_escape(article['author'])} et al.</p>
<p><strong>Abstract:</strong><br>{abstract}</p>
</section>
""")
    return "\n".join(blocks)


def render_score_table(scores, selected_pmids):
    rows = []
    for score in sorted(
        scores,
        key=lambda item: (
            item.get("total_score", 0),
            item.get("practice_change", 0),
            item.get("outpatient_usefulness", 0),
        ),
        reverse=True,
    ):
        status = "selected" if score["pmid"] in selected_pmids else "not selected"
        rows.append(
            "<tr>"
            f"<td>{html_escape(status)}</td>"
            f"<td>{html_escape(score['pmid'])}</td>"
            f"<td>{html_escape(score['title'])}</td>"
            f"<td>{html_escape(score['total_score'])}</td>"
            f"<td>{html_escape(score['useful_for_clinic'])}</td>"
            f"<td>{html_escape(score['short_reason'])}</td>"
            "</tr>"
        )
    return "\n".join(rows)


def write_integrated_html(search, articles, scores, final_result, now, output_dir, duplicate_pmids):
    os.makedirs(output_dir, exist_ok=True)
    title = f"{now.strftime('%Y-%m')}_{search.get('filename_label', search['label'])}_PubMed選定10本"
    path = os.path.join(output_dir, f"{safe_filename(title)}.html")
    selected = final_result["selected"]
    selected_pmids = {item["pmid"] for item in selected}

    content = f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>{html_escape(title)}</title>
<style>
body {{ font-family: Arial, "Hiragino Sans", "Yu Gothic", sans-serif; line-height: 1.65; color: #222; }}
h1, h2, h3 {{ line-height: 1.3; }}
table {{ border-collapse: collapse; width: 100%; margin: 16px 0 28px; }}
th, td {{ border: 1px solid #bbb; padding: 6px 8px; vertical-align: top; }}
th {{ background: #f1f3f5; }}
.meta {{ color: #555; }}
.rule {{ margin: 28px 0; border-top: 3px solid #333; }}
.paper {{ margin: 22px 0; }}
.separator {{ color: #555; }}
</style>
</head>
<body>
<h1>{html_escape(title)}</h1>
<p class="meta">取得日: {now.strftime('%Y年%m月%d日')} | 対象テーマ: {html_escape(search['label'])} | 選出: {len(articles)}件中{len(selected)}件</p>

<div class="rule"></div>
<h2>【第1部: 日本語版 選定結果】</h2>
<p>{html_escape(final_result.get('selection_summary', ''))}</p>

<h3>選定10本の一覧</h3>
<table>
<thead><tr><th>順位</th><th>PMID</th><th>タイトル</th><th>スコア</th><th>役立つか</th><th>重複状態</th><th>診療変更</th></tr></thead>
<tbody>
{render_selected_summary(selected)}
</tbody>
</table>

<p class="meta">重複PMID候補: {html_escape(', '.join(sorted(duplicate_pmids)) if duplicate_pmids else 'なし')}</p>

<h3>日本語要約</h3>
{render_japanese_blocks(selected)}

<div class="rule"></div>
<h2>【第2部: 英語 Abstract】</h2>
{render_abstracts(selected, articles)}

<div class="rule"></div>
<h2>【第3部: 候補論文スコア一覧】</h2>
<p class="meta">落選論文のabstract全文は含めていません。選定根拠を確認するための軽量な一覧です。</p>
<table>
<thead><tr><th>状態</th><th>PMID</th><th>タイトル</th><th>総合スコア</th><th>役立つか</th><th>短いメモ</th></tr></thead>
<tbody>
{render_score_table(scores, selected_pmids)}
</tbody>
</table>
</body>
</html>
"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

    json_path = os.path.splitext(path)[0] + ".json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(
            {"search": search, "scores": scores, "final": final_result},
            f,
            ensure_ascii=False,
            indent=2,
        )
    return path


def load_selection_history(path):
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_selection_history(path, history):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)


def duplicate_pmids_for(history, period_key, search_name, selected_this_run):
    period = history.get(period_key, {})
    duplicates = set(selected_this_run)
    for other_name, entry in period.items():
        if other_name == search_name:
            continue
        duplicates.update(entry.get("pmids", []))
    return duplicates


def update_history(history, period_key, search, final_result, now):
    period = history.setdefault(period_key, {})
    period[search["name"]] = {
        "label": search["label"],
        "updated_at": now.strftime("%Y-%m-%d %H:%M"),
        "pmids": [item["pmid"] for item in final_result.get("selected", [])],
    }


def process_search(search, args, now, history, selected_this_run):
    print(f"検索: {search['label']}")
    pmids, total = search_pubmed(search["query"], reldate=search["reldate"], retmax=args.retmax)
    time.sleep(REQUEST_INTERVAL)
    articles = fetch_abstracts(pmids)
    time.sleep(REQUEST_INTERVAL)
    print(f"  PubMed総数: {total}件 / 取得: {len(articles)}件")

    if args.dry_run:
        print("  dry-run: AI選定は実行しません")
        return None

    top_n = min(args.top_n, len(articles))
    if top_n == 0:
        print("  該当論文なし")
        return None
    if len(articles) < args.top_n:
        print(f"  注意: 論文数が{args.top_n}件未満のため、{top_n}件を選定します")

    print(f"  一次スコアリング: {args.screen_model}")
    scores = score_articles(search, articles, args)
    print(f"  最終選定: {args.final_model}")
    period_key = now.strftime("%Y-%m")
    duplicate_pmids = duplicate_pmids_for(history, period_key, search["name"], selected_this_run)
    if duplicate_pmids:
        print(f"  重複PMID候補: {len(duplicate_pmids)}件")
    final_result = final_select(search, articles, scores, args, top_n, duplicate_pmids)

    output_dir = os.path.join(os.path.abspath(args.output_dir), "ai_selected", now.strftime("%Y%m"))
    path = write_integrated_html(search, articles, scores, final_result, now, output_dir, duplicate_pmids)
    for item in final_result.get("selected", []):
        selected_this_run.add(item["pmid"])
    update_history(history, period_key, search, final_result, now)
    print(f"  出力: {path}")
    return path


def main():
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
    args = parse_args()
    now = datetime.now()
    searches = select_searches(args.frequency, args.topic)
    history_path = args.selection_history
    if not os.path.isabs(history_path):
        history_path = os.path.join(os.path.abspath(args.output_dir), history_path)
    history = load_selection_history(history_path)
    selected_this_run = set()

    print(f"PubMed AI Selector {now.strftime('%Y年%m月%d日 %H:%M')}")
    print(f"対象テーマ数: {len(searches)}")
    print(f"一次モデル: {args.screen_model} / 最終モデル: {args.final_model}")
    print()

    paths = []
    for search in searches:
        try:
            path = process_search(search, args, now, history, selected_this_run)
            if path:
                paths.append(path)
        except Exception as e:
            print(f"  エラー: {e}")

    if not args.dry_run:
        save_selection_history(history_path, history)
        print(f"選定PMID履歴: {history_path}")

    print()
    print("完了")
    if paths:
        print("作成ファイル:")
        for path in paths:
            print(f"  {path}")


if __name__ == "__main__":
    main()
