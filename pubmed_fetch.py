#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PubMed Monthly Abstract Fetcher
=================================
毎月1回ターミナルで実行すると、保存したPubMed検索クエリの
アブストラクトをすべて取得し、Markdownファイルとして保存します。

使い方:
    python3 pubmed_fetch.py

出力:
    abstracts_YYYYMM.md  (例: abstracts_202606.md)
"""

import urllib.request
import urllib.parse
import urllib.error
import json
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
import time
import os
import argparse
import html
import re
import subprocess

# ============================================================
# ★ 設定: 検索クエリ一覧
#
# reldate: 何日以内の論文を取得するか（0 = クエリ内の日付フィルタを使用）
# ============================================================

SEARCHES = [
    {
        "name": "primary_care_review",
        "label": "プライマリケア（レビュー・ガイドライン）",
        "filename_label": "プライマリケアレビュー",   # Google Docファイル名に使用
        "frequency": "monthly",
        "aliases": ["primary care", "プライマリケア"],
        "query": '(child* OR pediatric*) AND ("primary care") AND (guideline[pt] OR review[pt] OR systematic review[pt]) AND ("last 30 days"[dp])',
        "reldate": 0,   # クエリ内に日付フィルタあり
    },
    {
        "name": "Pediatric_Primary_Care_High_Impact",
        "label": "小児プライマリケア（高インパクト）",
        "filename_label": "小児プライマリケア",
        "frequency": "monthly",
        "aliases": ["high impact", "小児プライマリケア"],
        "query": '(child* OR pediatric*) AND ("primary care" OR outpatient) AND (guideline[pt] OR practice guideline[pt] OR meta-analysis[pt] OR randomized controlled trial[pt]) AND ("last 30 days"[dp])',
        "reldate": 0,
    },
    {
        "name": "ped_sleep_update",
        "label": "小児睡眠",
        "filename_label": "小児睡眠",
        "frequency": "monthly",
        "aliases": ["sleep", "睡眠"],
        "query": '(child* OR pediatric*) AND "sleep wake disorders" AND (guideline[Filter] OR "meta-analysis"[Filter])',
        "reldate": 30,  # クエリに日付フィルタなし → 直近30日で絞る
    },
    {
        "name": "ped_psycho_update",
        "label": "小児心身症・ゲーム障害・ネット依存",
        "filename_label": "小児心身症",
        "frequency": "monthly",
        "aliases": ["psychosomatic", "gaming", "internet", "心身症", "ゲーム障害", "ネット依存"],
        "query": '(child* OR pediatric*) AND (psychosomatic OR "internet addiction" OR "gaming disorder") AND (guideline[Filter] OR review[Filter] OR "systematic review"[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_trauma_update",
        "label": "小児外傷・熱性けいれん・頭部外傷",
        "filename_label": "小児外傷",
        "frequency": "monthly",
        "aliases": ["trauma", "febrile seizure", "head injury", "外傷", "熱性けいれん", "頭部外傷"],
        "query": '(child* OR pediatric*) AND ("febrile seizure" OR "head injury" OR "minor trauma") AND (guideline[Filter] OR "meta-analysis"[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_vaccine_update",
        "label": "小児ワクチン（副反応）",
        "filename_label": "小児ワクチン",
        "frequency": "monthly",
        "aliases": ["vaccine", "ワクチン", "副反応"],
        "query": '(child* OR pediatric*) AND vaccine AND "adverse effects" AND (review[Filter] OR guideline[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_nephrology_update",
        "label": "小児腎臓（ネフローゼ・IgA腎症）",
        "filename_label": "小児腎臓",
        "frequency": "monthly",
        "aliases": ["nephrology", "nephrotic", "IgA", "腎臓", "ネフローゼ"],
        "query": '(child* OR pediatric*) AND (nephrology OR "nephrotic syndrome" OR "IgA nephropathy") AND (guideline[Filter] OR review[Filter] OR "systematic review"[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_constipation_update",
        "label": "小児便秘",
        "filename_label": "便秘",
        "frequency": "monthly",
        "aliases": ["constipation", "便秘"],
        "query": '(child* OR pediatric*) AND constipation AND (guideline[Filter] OR review[Filter] OR "systematic review"[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_enuresis_update",
        "label": "夜尿症",
        "filename_label": "夜尿症",
        "frequency": "monthly",
        "aliases": ["enuresis", "夜尿"],
        "query": 'enuresis AND (review[Filter] OR guideline[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_infection_1w_update",
        "label": "小児感染症（週次）",
        "filename_label": "小児感染症",
        "frequency": "weekly",
        "aliases": ["infection", "infectious", "感染症"],
        "query": '(child* OR pediatric* OR paediatric*) AND (pneumonia OR otitis media OR pharyngitis OR "urinary tract infection" OR influenza OR RSV OR "respiratory syncytial virus" OR "antimicrobial stewardship" OR "acute gastroenteritis" OR norovirus OR rotavirus) AND (guideline[pt] OR practice guideline[pt] OR systematic review[pt] OR meta-analysis[pt] OR randomized controlled trial[pt])',
        "reldate": 7,
    },
    {
        "name": "ped_food_update",
        "label": "小児食物アレルギー",
        "filename_label": "食物アレルギー",
        "frequency": "monthly",
        "aliases": ["food allergy", "食物アレルギー"],
        "query": '(child* OR pediatric*) AND "food allergy" AND (guideline[Filter] OR review[Filter] OR "systematic review"[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_atopic_update",
        "label": "小児アトピー性皮膚炎",
        "filename_label": "アトピー性皮膚炎",
        "frequency": "monthly",
        "aliases": ["atopic dermatitis", "eczema", "アトピー"],
        "query": '(child* OR pediatric*) AND "atopic dermatitis" AND (guideline[Filter] OR review[Filter] OR "systematic review"[Filter])',
        "reldate": 30,
    },
    {
        "name": "peds_asthma_update",
        "label": "小児喘息",
        "filename_label": "気管支喘息",
        "frequency": "monthly",
        "aliases": ["asthma", "喘息", "気管支喘息"],
        "query": '(child* OR pediatric*) AND asthma AND (guideline[Filter] OR review[Filter] OR "systematic review"[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_development_update",
        "label": "小児発達（ADHD・ASD・起立性調節障害）",
        "filename_label": "発達障害",
        "frequency": "monthly",
        "aliases": ["development", "ADHD", "ASD", "発達", "起立性調節障害"],
        "query": '(ADHD OR "autism spectrum disorder" OR "orthostatic dysregulation") AND (guideline[Filter] OR "meta-analysis"[Filter])',
        "reldate": 30,
    },
]

# 出力先フォルダ（このスクリプトと同じフォルダ）
OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))

# NCBIへのリクエスト間隔（秒）
REQUEST_INTERVAL = 0.4

# ============================================================
# 以下は変更不要です
# ============================================================

ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
EFETCH_URL  = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"


def fetch_url(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pubmed_fetch/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code != 429 and not 500 <= exc.code < 600:
                raise
            if attempt == 3:
                raise
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            delay = float(retry_after) if retry_after and retry_after.isdigit() else 2**attempt
            time.sleep(max(1.0, delay))
        except urllib.error.URLError:
            if attempt == 3:
                raise
            time.sleep(2**attempt)
    raise RuntimeError("PubMed APIの再試行上限に達しました。")


def fetch_json(url):
    """一時的に壊れたJSONが返る場合も再試行する。"""
    for attempt in range(4):
        raw = fetch_url(url)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            # ESearchがquerytranslation等の文字列内に未エスケープの
            # 制御文字を返すことがある。構造が完全なら緩和解析で読める。
            try:
                return json.loads(raw, strict=False)
            except json.JSONDecodeError:
                pass
        except UnicodeDecodeError:
            pass
        if attempt < 3:
            time.sleep(2**attempt)
        else:
            raise RuntimeError("PubMed APIから有効なJSONを取得できませんでした。")
    raise RuntimeError("PubMed APIのJSON再試行上限に達しました。")


def search_pubmed(query, reldate=0, retmax=100):
    """検索クエリでPMIDリストを取得"""
    params = {
        "db":     "pubmed",
        "term":   query,
        "retmax": retmax,
        "retmode": "json",
    }
    if reldate > 0:
        params["datetype"] = "pdat"
        params["reldate"]  = reldate

    data = fetch_json(f"{ESEARCH_URL}?{urllib.parse.urlencode(params)}")
    ids   = data.get("esearchresult", {}).get("idlist", [])
    count = data.get("esearchresult", {}).get("count", "0")
    return ids, int(count)


def search_pubmed_edat(
    query,
    start_date,
    end_date,
    page_size=500,
    max_records=10000,
    request_interval=REQUEST_INTERVAL,
):
    """EDAT範囲で検索し、ESearchをページングしてPMIDをすべて取得する。

    既存クエリに含まれる相対日付指定は、自動監視ではEDAT範囲と競合するため除去する。
    """
    clean_query = re.sub(
        r'\s+AND\s+\("?last\s+\d+\s+days"?\[dp\]\)?',
        "",
        query,
        flags=re.IGNORECASE,
    )
    clean_query = re.sub(
        r'\s+AND\s+\("?last\s+\d+\s+days"?\[pdat\]\)?',
        "",
        clean_query,
        flags=re.IGNORECASE,
    )
    start_term = str(start_date).replace("-", "/")
    end_term = str(end_date).replace("-", "/")
    term = f"({clean_query}) AND ({start_term}[edat] : {end_term}[edat])"
    ids = []
    total = None
    retstart = 0
    while total is None or retstart < min(total, max_records):
        retmax = min(page_size, max_records - retstart)
        if retmax <= 0:
            break
        params = {
            "db": "pubmed",
            "term": term,
            "retstart": retstart,
            "retmax": retmax,
            "retmode": "json",
            "sort": "pub date",
        }
        data = fetch_json(f"{ESEARCH_URL}?{urllib.parse.urlencode(params)}")
        result = data.get("esearchresult", {})
        total = int(result.get("count", "0"))
        page_ids = result.get("idlist", [])
        ids.extend(page_ids)
        if not page_ids:
            break
        retstart += len(page_ids)
        if retstart < min(total, max_records):
            time.sleep(request_interval)
    if total is not None and total > max_records:
        raise RuntimeError(
            f"PubMed検索結果{total}件がmax_records={max_records}を超えました。"
            "取りこぼしを防ぐため上限を増やして再実行してください。"
        )
    # ページ境界などで重複しても入力順を保って一意化する。
    return list(dict.fromkeys(ids)), int(total or 0)


def search_pubmed_date_range(
    query,
    start_date,
    end_date,
    datetype="pdat",
    page_size=500,
    max_records=10000,
    request_interval=REQUEST_INTERVAL,
):
    """任意の日付フィールドの範囲でESearchをページングする。

    見逃し再検索では、PubMedへの収載日ではなく論文の発行日（pdat）を使う。
    通常監視のEDAT検索とは目的が異なるため、明示的に別関数としている。
    """
    if datetype not in {"pdat", "edat", "mdat"}:
        raise ValueError(f"未対応の日付フィールドです: {datetype}")
    start_value = (
        start_date if isinstance(start_date, date) else date.fromisoformat(str(start_date))
    )
    end_value = end_date if isinstance(end_date, date) else date.fromisoformat(str(end_date))
    if start_value > end_value:
        raise ValueError("検索開始日は終了日以前にしてください。")
    start_term = str(start_value).replace("-", "/")
    end_term = str(end_value).replace("-", "/")
    term = f"({query}) AND ({start_term}[{datetype}] : {end_term}[{datetype}])"
    ids = []
    total = None
    retstart = 0
    while total is None or retstart < min(total, max_records):
        retmax = min(page_size, max_records - retstart)
        if retmax <= 0:
            break
        params = {
            "db": "pubmed",
            "term": term,
            "retstart": retstart,
            "retmax": retmax,
            "retmode": "json",
            "sort": "pub date",
        }
        data = fetch_json(f"{ESEARCH_URL}?{urllib.parse.urlencode(params)}")
        result = data.get("esearchresult", {})
        total = int(result.get("count", "0"))
        if total > max_records:
            if start_value == end_value:
                raise RuntimeError(
                    f"{start_value.isoformat()}だけでPubMed検索結果{total}件が"
                    f"max_records={max_records}を超えました。"
                )
            midpoint = start_value + (end_value - start_value) // 2
            left_ids, left_total = search_pubmed_date_range(
                query,
                start_value,
                midpoint,
                datetype=datetype,
                page_size=page_size,
                max_records=max_records,
                request_interval=request_interval,
            )
            right_ids, right_total = search_pubmed_date_range(
                query,
                midpoint + timedelta(days=1),
                end_value,
                datetype=datetype,
                page_size=page_size,
                max_records=max_records,
                request_interval=request_interval,
            )
            return list(dict.fromkeys(left_ids + right_ids)), left_total + right_total
        page_ids = result.get("idlist", [])
        ids.extend(page_ids)
        if not page_ids:
            break
        retstart += len(page_ids)
        if retstart < min(total, max_records):
            time.sleep(request_interval)
    return list(dict.fromkeys(ids)), int(total or 0)


def fetch_abstracts(pmids):
    """PMIDリストから論文情報を取得"""
    if not pmids:
        return []

    params = urllib.parse.urlencode({
        "db":      "pubmed",
        "id":      ",".join(pmids),
        "rettype": "abstract",
        "retmode": "xml",
    })
    xml_data = fetch_url(f"{EFETCH_URL}?{params}")

    root     = ET.fromstring(xml_data)
    articles = []

    for art in root.findall(".//PubmedArticle"):
        pmid_el = art.find(".//PMID")
        pmid    = pmid_el.text if pmid_el is not None else "?"

        title_el = art.find(".//ArticleTitle")
        title    = "".join(title_el.itertext()) if title_el is not None else "(no title)"

        # アブストラクト（複数セクション対応）
        abstract_parts = []
        for ab in art.findall(".//AbstractText"):
            label = ab.get("Label", "")
            text  = "".join(ab.itertext())
            abstract_parts.append(f"{label}: {text}" if label else text)
        abstract = "\n".join(abstract_parts) if abstract_parts else "(abstract not available)"

        journal_el = art.find(".//Journal/Title")
        journal    = journal_el.text if journal_el is not None else "?"

        year_el  = art.find(".//PubDate/Year")
        month_el = art.find(".//PubDate/Month")
        year     = year_el.text  if year_el  is not None else "?"
        month    = month_el.text if month_el is not None else ""

        author_el = art.find(".//AuthorList/Author[1]")
        if author_el is not None:
            last   = author_el.findtext("LastName", "")
            fore   = author_el.findtext("ForeName", "")
            author = f"{last} {fore}".strip() or "?"
        else:
            author = "?"

        publication_types = [
            "".join(item.itertext()).strip()
            for item in art.findall(".//PublicationTypeList/PublicationType")
            if "".join(item.itertext()).strip()
        ]

        articles.append({
            "pmid":     pmid,
            "title":    title,
            "abstract": abstract,
            "journal":  journal,
            "year":     year,
            "month":    month,
            "author":   author,
            "publication_types": publication_types,
        })

    return articles


def format_article(idx, art):
    pub_date = f"{art['year']}/{art['month']}" if art['month'] else art['year']
    return "\n".join([
        f"### [{idx}] {art['title']}",
        f"**Author**: {art['author']} et al. | **Journal**: {art['journal']} ({pub_date})",
        f"**PMID**: {art['pmid']} | https://pubmed.ncbi.nlm.nih.gov/{art['pmid']}/",
        "",
        art['abstract'],
        "",
        "---",
        "",
    ])


def safe_filename(text):
    """Google Driveに上げやすいファイル名に整える"""
    text = re.sub(r'[\\/:*?"<>|]+', "_", text)
    text = re.sub(r"\s+", "_", text).strip("._ ")
    return text or "pubmed"


def build_doc_prompt(label, doc_title, period_label):
    return "\n".join([
        f"以下は{period_label}の{label}領域の論文一覧です。",
        "外来小児科医として診療を変える可能性があるものだけ10本に厳選し、要約してください。",
        "",
        f"Google Docのタイトルは「{doc_title}」にしてください。",
        "",
        "Google Docは以下の2部構成にしてください。",
        "",
        "【第1部: 日本語要約】",
        "各論文は独立したブロックとして表示し、論文ごとに区切り線「---」を入れてください。",
        "各項目の間には1行空行を入れてください。",
        "",
        "①タイトル",
        "②PMID（PMIDは必ず入力データに含まれるものを正確に転記）",
        "③なぜ重要か（1〜2文）",
        "④臨床への影響（1〜2文）",
        "⑤診療変更の必要性（Yes / No + 一言）",
        "",
        "【第2部: 英語 Abstract】",
        "同じ10本を同じ番号順で並べ、各論文を「---」で区切って以下の形式で記載してください。",
        "",
        "番号. タイトル",
        "PMID: 番号",
        "Journal: 雑誌名（発行年）",
        "Abstract: 英語のアブストラクト全文",
    ])


def period_label_for(search):
    return "直近1週間" if search.get("frequency") == "weekly" else "直近1ヶ月"


def doc_title_for(search, now):
    filename_label = search.get("filename_label", search["label"])
    return f"{now.strftime('%Y-%m')}_{filename_label}_PubMed抽出"


def format_article_html(idx, art):
    pub_date = f"{art['year']}/{art['month']}" if art['month'] else art['year']
    title = html.escape(art["title"])
    author = html.escape(art["author"])
    journal = html.escape(art["journal"])
    pmid = html.escape(art["pmid"])
    abstract = html.escape(art["abstract"]).replace("\n", "<br>")
    pubmed_url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"
    return f"""
<section class="article">
  <h3>{idx}. {title}</h3>
  <p><strong>Author:</strong> {author} et al. | <strong>Journal:</strong> {journal} ({html.escape(pub_date)})</p>
  <p><strong>PMID:</strong> {pmid} | <a href="{pubmed_url}">{pubmed_url}</a></p>
  <p>{abstract}</p>
</section>
"""


def write_topic_html(search, articles, now, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    doc_title = doc_title_for(search, now)
    period_label = period_label_for(search)
    prompt = build_doc_prompt(search["label"], doc_title, period_label)
    file_path = os.path.join(output_dir, f"{safe_filename(doc_title)}.html")

    articles_html = "\n".join(format_article_html(i, art) for i, art in enumerate(articles, 1))
    content = f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>{html.escape(doc_title)}</title>
  <style>
    body {{ font-family: Arial, "Hiragino Sans", "Yu Gothic", sans-serif; line-height: 1.6; }}
    h1, h2, h3 {{ line-height: 1.3; }}
    .meta {{ color: #555; }}
    .prompt {{ background: #f6f8fa; border-left: 4px solid #8a8f98; padding: 12px 16px; white-space: pre-wrap; }}
    .article {{ border-top: 1px solid #ccc; margin-top: 24px; padding-top: 16px; }}
  </style>
</head>
<body>
  <h1>{html.escape(doc_title)}</h1>
  <p class="meta">取得日時: {now.strftime('%Y-%m-%d %H:%M')} / テーマ: {html.escape(search["label"])} / 対象期間: {html.escape(period_label)} / 件数: {len(articles)}</p>

  <h2>ChatGPT / Gemini / Claude への依頼文</h2>
  <div class="prompt">{html.escape(prompt)}</div>

  <h2>PubMed Abstract一覧</h2>
  {articles_html if articles else "<p>該当論文なし</p>"}
</body>
</html>
"""
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    return file_path


def normalize_text(text):
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def format_article_paste_text(idx, art):
    return "\n".join([
        f"{idx}.",
        "",
        "Title:",
        normalize_text(art["title"]),
        "",
        "PMID:",
        art["pmid"],
        "",
        "Journal:",
        f"{art['journal']} ({art['year']}{'/' + art['month'] if art['month'] else ''})",
        "",
        "Abstract:",
        normalize_text(art["abstract"]),
        "",
        "---",
        "",
    ])


def write_chatgpt_paste_text(search, articles, now, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    title = f"{now.strftime('%Y-%m')}_{search.get('filename_label', search['label'])}_ChatGPT貼付用"
    file_path = os.path.join(output_dir, f"{safe_filename(title)}.txt")
    period_label = period_label_for(search)

    content = "\n".join([
        "【領域】",
        search["label"],
        "",
        "【対象期間】",
        period_label,
        "",
        "【目的】",
        "外来小児科医として診療を変える可能性がある論文を10本程度に厳選するためのPubMed abstract一覧です。",
        "出力形式・選定基準はChatGPT Project Instructionsに従ってください。",
        "PMIDは必ず入力データに含まれるものを正確に転記してください。",
        "",
        "【論文一覧】",
        "",
        "".join(format_article_paste_text(i, art) for i, art in enumerate(articles, 1)),
    ])

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    return file_path, content


def copy_to_clipboard(text):
    subprocess.run(["pbcopy"], input=text, text=True, check=True)


def matches_topic(search, topic):
    needle = topic.casefold()
    haystacks = [
        search["name"],
        search["label"],
        search.get("filename_label", ""),
        *search.get("aliases", []),
    ]
    return any(needle in value.casefold() for value in haystacks)


def select_searches(frequency, topics):
    selected = [
        search for search in SEARCHES
        if frequency == "all" or search.get("frequency", "monthly") == frequency
    ]
    if not topics:
        return selected

    topic_values = []
    for topic in topics:
        topic_values.extend(part.strip() for part in topic.split(",") if part.strip())

    matched = []
    missing = []
    for topic in topic_values:
        topic_matches = [search for search in selected if matches_topic(search, topic)]
        if topic_matches:
            for search in topic_matches:
                if search not in matched:
                    matched.append(search)
        else:
            missing.append(topic)

    if missing:
        choices = ", ".join(search["name"] for search in selected)
        raise ValueError(f"テーマが見つかりません: {', '.join(missing)}\n利用可能: {choices}")

    return matched


def parse_args():
    parser = argparse.ArgumentParser(
        description="PubMedからテーマ別にabstractを取得し、MarkdownとGoogle Docs取り込み用HTMLを作成します。"
    )
    parser.add_argument(
        "--frequency",
        choices=["all", "monthly", "weekly"],
        default="all",
        help="実行する頻度グループ。通常月次は monthly、小児感染症のみ週次は weekly。",
    )
    parser.add_argument(
        "--topic",
        action="append",
        help="実行するテーマ名。例: --topic asthma / --topic constipation / --topic 小児感染症。複数指定可。",
    )
    parser.add_argument(
        "--retmax",
        type=int,
        default=100,
        help="各テーマで取得する最大件数。",
    )
    parser.add_argument(
        "--no-topic-docs",
        action="store_true",
        help="テーマ別Google Docs取り込み用HTMLを作らない。",
    )
    parser.add_argument(
        "--paste-text-only",
        action="store_true",
        help="ChatGPT貼り付け用txtだけを作成する。",
    )
    parser.add_argument(
        "--copy-paste-text",
        action="store_true",
        help="作成したChatGPT貼り付け用txtの内容をクリップボードへコピーする。",
    )
    parser.add_argument(
        "--output-dir",
        default=OUTPUT_DIR,
        help="出力先フォルダ。",
    )
    return parser.parse_args()


def output_stem(month_str, frequency, topics):
    if topics:
        topic_slug = safe_filename("_".join(
            part.strip()
            for topic in topics
            for part in topic.split(",")
            if part.strip()
        ))
        return f"abstracts_{month_str}_{topic_slug}"
    if frequency in ("monthly", "weekly"):
        return f"abstracts_{month_str}_{frequency}"
    return f"abstracts_{month_str}"


def main():
    args = parse_args()
    now        = datetime.now()
    month_str  = now.strftime("%Y%m")
    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"{output_stem(month_str, args.frequency, args.topic)}.md")
    topic_doc_dir = os.path.join(output_dir, "google_docs", month_str)
    paste_text_dir = os.path.join(output_dir, "chatgpt_paste", month_str)
    searches = select_searches(args.frequency, args.topic)

    print(f"PubMed Abstract Fetcher  {now.strftime('%Y年%m月%d日 %H:%M')}")
    print("=" * 50)
    print(f"検索テーマ数: {len(searches)}")
    if not args.paste_text_only:
        print(f"出力先: {output_path}")
    print(f"ChatGPT貼付用txt: {paste_text_dir}")
    if not args.no_topic_docs and not args.paste_text_only:
        print(f"Google Docs取り込み用HTML: {topic_doc_dir}")
    print()

    # ファイルヘッダー（Coworkへの指示付き）
    header = f"""# PubMed Abstracts — {now.strftime('%Y年%m月')}
取得日時: {now.strftime('%Y-%m-%d %H:%M')}

---

## ▼ Coworkでの使い方

処理したいテーマのセクションを指定して、以下のプロンプトをCoworkに貼り付けてください。
各セクションの冒頭にコピー用プロンプトが用意されています。

**Google Docs取り込み用HTMLのファイル名形式:** `YYYY-MM_テーマ名_PubMed抽出.html`
（例: `{now.strftime('%Y-%m')}_気管支喘息_PubMed抽出.html`）

**HTMLの構成:**
- 冒頭: 重要論文10本の厳選・要約用プロンプト
- 本文: PubMedから取得した英語Abstract一覧

---

"""

    sections    = [header]
    grand_total = 0
    toc_lines   = ["## 目次\n"]

    topic_doc_paths = []
    paste_text_paths = []
    paste_texts_for_clipboard = []

    for s in searches:
        name    = s["name"]
        label   = s["label"]
        query   = s["query"]
        reldate = s["reldate"]
        period_label = period_label_for(s)

        print(f"🔍 {label} ...", end=" ", flush=True)
        toc_lines.append(f"- [{label}](#{name.lower().replace('_','-')}): ")

        try:
            pmids, total = search_pubmed(query, reldate=reldate, retmax=args.retmax)
            time.sleep(REQUEST_INTERVAL)

            if not pmids:
                print("0件")
                toc_lines[-1] += "0件"
                sections.append(f"## {name}\n### {label}\n\n*該当論文なし*\n\n---\n\n")
                continue

            articles = fetch_abstracts(pmids)
            time.sleep(REQUEST_INTERVAL)

            print(f"{len(articles)}件 (PubMed総数: {total}件)")
            toc_lines[-1] += f"{len(articles)}件"
            grand_total += len(articles)

            doc_title = doc_title_for(s, now)
            paste_path, paste_text = write_chatgpt_paste_text(s, articles, now, paste_text_dir)
            paste_text_paths.append(paste_path)
            paste_texts_for_clipboard.append(paste_text)

            if args.paste_text_only:
                continue

            if not args.no_topic_docs:
                topic_doc_paths.append(write_topic_html(s, articles, now, topic_doc_dir))

            section  = f"## {name}\n### {label} — {len(articles)}件\n\n"
            section += "**▼ Coworkへのプロンプト（コピーして貼り付け）:**\n\n"
            section += f"> 以下は{period_label}の{label}領域の論文一覧です。\n"
            section += f"> 外来小児科医として診療を変える可能性があるもの10本程度に厳選し、\n"
            section += f"> **「{doc_title}」** というタイトルのGoogle Docを作成してください。\n"
            section += f">\n"
            section += f"> Google Docは以下の2部構成にしてください:\n"
            section += f">\n"
            section += f"> **【第1部: 日本語要約】**\n"
            section += f"> 厳選した論文を 1, 2, 3... の番号順に並べ、各論文を「---」で区切って以下の形式で記載:\n"
            section += f"> ① タイトル（英語）\n"
            section += f"> ② PMID（入力データのものを正確に転記）\n"
            section += f"> ③ なぜ重要か（1〜2文）\n"
            section += f"> ④ 臨床への影響（1〜2文）\n"
            section += f"> ⑤ 診療変更の必要性（Yes/No + 一言）\n"
            section += f">\n"
            section += f"> **【第2部: 英語 Abstract】**\n"
            section += f"> 同じ10本を同じ番号順で並べ、各論文を「---」で区切って以下の形式で記載:\n"
            section += f"> 番号. タイトル\n"
            section += f"> PMID: （番号）\n"
            section += f"> Journal: （雑誌名）（発行年）\n"
            section += f"> Abstract: （英語のアブストラクト全文）\n"
            section += f"\n\n"

            for i, art in enumerate(articles, 1):
                section += format_article(i, art)

            sections.append(section)

        except Exception as e:
            print(f"エラー: {e}")
            toc_lines[-1] += "エラー"
            sections.append(f"## {name}\n### {label}\n\n*取得エラー: {e}*\n\n---\n\n")

    if not args.paste_text_only:
        # 目次を挿入
        toc = "\n".join(toc_lines) + "\n\n---\n\n"
        sections.insert(1, toc)

        full_text  = "\n".join(sections)
        full_text += f"\n---\n*取得完了: {now.strftime('%Y-%m-%d %H:%M')} | 合計 {grand_total} 件*\n"

        with open(output_path, "w", encoding="utf-8") as f:
            f.write(full_text)

    if args.copy_paste_text and paste_texts_for_clipboard:
        combined_text = "\n\n==============================\n\n".join(paste_texts_for_clipboard)
        copy_to_clipboard(combined_text)

    print()
    print("=" * 50)
    print(f"✅ 完了！合計 {grand_total} 件を保存しました")
    if not args.paste_text_only:
        print(f"📄 {output_path}")
    if paste_text_paths:
        print(f"📋 ChatGPT貼付用txt: {paste_text_dir}")
    if args.copy_paste_text and paste_texts_for_clipboard:
        print("📋 ChatGPT貼付用txtをクリップボードにコピーしました")
    if topic_doc_paths:
        print(f"📁 Google Docs取り込み用HTML: {topic_doc_dir}")
    print()
    if args.paste_text_only:
        print("【次のステップ】ChatGPT Projectを開き、クリップボードの内容を貼り付けてください。")
        print("Project Instructions側に選定基準と出力形式を保存しておく想定です。")
    else:
        print("【次のステップ】Coworkを開き、abstracts_*.md を開いて")
        print("処理したいテーマのプロンプトをコピーしてClaudeに貼り付けてください。")
        if topic_doc_paths:
            print("または google_docs フォルダ内のHTMLをGoogle Driveへアップロードすると、")
            print("テーマ別のGoogle DocとしてNotebookLMに取り込めます。")
        print()
        print("作成されるテーマ別HTMLの例:")
        print(f"  {now.strftime('%Y-%m')}_気管支喘息_PubMed抽出.html")
        print("  　 冒頭: 重要論文10本の厳選・要約用プロンプト")
        print("  　 本文: PubMedから取得した英語Abstract一覧")


if __name__ == "__main__":
    try:
        main()
    except ValueError as e:
        print(f"エラー: {e}")
        raise SystemExit(2)
