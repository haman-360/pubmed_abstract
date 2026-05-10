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
import json
import xml.etree.ElementTree as ET
from datetime import datetime
import time
import os

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
        "query": '(child* OR pediatric*) AND ("primary care") AND (guideline[pt] OR review[pt] OR systematic review[pt]) AND ("last 30 days"[dp])',
        "reldate": 0,   # クエリ内に日付フィルタあり
    },
    {
        "name": "Pediatric_Primary_Care_High_Impact",
        "label": "小児プライマリケア（高インパクト）",
        "filename_label": "小児プライマリケア",
        "query": '(child* OR pediatric*) AND ("primary care" OR outpatient) AND (guideline[pt] OR practice guideline[pt] OR meta-analysis[pt] OR randomized controlled trial[pt]) AND ("last 30 days"[dp])',
        "reldate": 0,
    },
    {
        "name": "ped_sleep_update",
        "label": "小児睡眠",
        "filename_label": "小児睡眠",
        "query": '(child* OR pediatric*) AND "sleep wake disorders" AND (guideline[Filter] OR "meta-analysis"[Filter])',
        "reldate": 30,  # クエリに日付フィルタなし → 直近30日で絞る
    },
    {
        "name": "ped_psycho_update",
        "label": "小児心身症・ゲーム障害・ネット依存",
        "filename_label": "小児心身症",
        "query": '(child* OR pediatric*) AND (psychosomatic OR "internet addiction" OR "gaming disorder") AND (guideline[Filter] OR review[Filter] OR "systematic review"[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_trauma_update",
        "label": "小児外傷・熱性けいれん・頭部外傷",
        "filename_label": "小児外傷",
        "query": '(child* OR pediatric*) AND ("febrile seizure" OR "head injury" OR "minor trauma") AND (guideline[Filter] OR "meta-analysis"[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_vaccine_update",
        "label": "小児ワクチン（副反応）",
        "filename_label": "小児ワクチン",
        "query": '(child* OR pediatric*) AND vaccine AND "adverse effects" AND (review[Filter] OR guideline[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_nephrology_update",
        "label": "小児腎臓（ネフローゼ・IgA腎症）",
        "filename_label": "小児腎臓",
        "query": '(child* OR pediatric*) AND (nephrology OR "nephrotic syndrome" OR "IgA nephropathy") AND (guideline[Filter] OR review[Filter] OR "systematic review"[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_constipation_update",
        "label": "小児便秘",
        "filename_label": "便秘",
        "query": '(child* OR pediatric*) AND constipation AND (guideline[Filter] OR review[Filter] OR "systematic review"[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_enuresis_update",
        "label": "夜尿症",
        "filename_label": "夜尿症",
        "query": 'enuresis AND (review[Filter] OR guideline[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_infection_1w_update",
        "label": "小児感染症（週次・直近30日）",
        "filename_label": "小児感染症",
        "query": '(child* OR pediatric* OR paediatric*) AND (pneumonia OR otitis media OR pharyngitis OR "urinary tract infection" OR influenza OR RSV OR "respiratory syncytial virus" OR "antimicrobial stewardship" OR "acute gastroenteritis" OR norovirus OR rotavirus) AND (guideline[pt] OR practice guideline[pt] OR systematic review[pt] OR meta-analysis[pt] OR randomized controlled trial[pt]) AND ("last 30 days"[dp])',
        "reldate": 0,
    },
    {
        "name": "ped_food_update",
        "label": "小児食物アレルギー",
        "filename_label": "食物アレルギー",
        "query": '(child* OR pediatric*) AND "food allergy" AND (guideline[Filter] OR review[Filter] OR "systematic review"[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_atopic_update",
        "label": "小児アトピー性皮膚炎",
        "filename_label": "アトピー性皮膚炎",
        "query": '(child* OR pediatric*) AND "atopic dermatitis" AND (guideline[Filter] OR review[Filter] OR "systematic review"[Filter])',
        "reldate": 30,
    },
    {
        "name": "peds_asthma_update",
        "label": "小児喘息",
        "filename_label": "気管支喘息",
        "query": '(child* OR pediatric*) AND asthma AND (guideline[Filter] OR review[Filter] OR "systematic review"[Filter])',
        "reldate": 30,
    },
    {
        "name": "ped_development_update",
        "label": "小児発達（ADHD・ASD・起立性調節障害）",
        "filename_label": "発達障害",
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
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


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

    data = json.loads(fetch_url(f"{ESEARCH_URL}?{urllib.parse.urlencode(params)}"))
    ids   = data.get("esearchresult", {}).get("idlist", [])
    count = data.get("esearchresult", {}).get("count", "0")
    return ids, int(count)


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

        articles.append({
            "pmid":     pmid,
            "title":    title,
            "abstract": abstract,
            "journal":  journal,
            "year":     year,
            "month":    month,
            "author":   author,
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


def main():
    now        = datetime.now()
    month_str  = now.strftime("%Y%m")
    output_path = os.path.join(OUTPUT_DIR, f"abstracts_{month_str}.md")

    print(f"PubMed Abstract Fetcher  {now.strftime('%Y年%m月%d日 %H:%M')}")
    print("=" * 50)
    print(f"検索テーマ数: {len(SEARCHES)}")
    print(f"出力先: {output_path}")
    print()

    # ファイルヘッダー（Coworkへの指示付き）
    header = f"""# PubMed Abstracts — {now.strftime('%Y年%m月')}
取得日時: {now.strftime('%Y-%m-%d %H:%M')}

---

## ▼ Coworkでの使い方

処理したいテーマのセクションを指定して、以下のプロンプトをCoworkに貼り付けてください。
各セクションの冒頭にコピー用プロンプトが用意されています。

**Google Docのファイル名形式:** `YYYY-MM_テーマ名_abstract10本`
（例: `{now.strftime('%Y-%m')}_気管支喘息_abstract10本`）

**Google Docの構成（2部構成）:**
- 第1部: 日本語要約（①〜⑤の形式で10本）
- 第2部: 英語 Abstract（同じ10本のfull abstractを番号順に掲載）

---

"""

    sections    = [header]
    grand_total = 0
    toc_lines   = ["## 目次\n"]

    for s in SEARCHES:
        name    = s["name"]
        label   = s["label"]
        query   = s["query"]
        reldate = s["reldate"]

        print(f"🔍 {label} ...", end=" ", flush=True)
        toc_lines.append(f"- [{label}](#{name.lower().replace('_','-')}): ")

        try:
            pmids, total = search_pubmed(query, reldate=reldate)
            time.sleep(REQUEST_INTERVAL)

            toc_lines[-1] += f"{len(pmids)}件"

            if not pmids:
                print("0件")
                sections.append(f"## {name}\n### {label}\n\n*該当論文なし*\n\n---\n\n")
                continue

            articles = fetch_abstracts(pmids)
            time.sleep(REQUEST_INTERVAL)

            print(f"{len(articles)}件 (PubMed総数: {total}件)")
            grand_total += len(articles)

            filename_label = s.get("filename_label", label)
            doc_title = f"{now.strftime('%Y-%m')}_{filename_label}_abstract10本"

            section  = f"## {name}\n### {label} — {len(articles)}件\n\n"
            section += "**▼ Coworkへのプロンプト（コピーして貼り付け）:**\n\n"
            section += f"> 以下は直近1ヶ月の{label}領域の論文一覧です。\n"
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

    # 目次を挿入
    toc = "\n".join(toc_lines) + "\n\n---\n\n"
    sections.insert(1, toc)

    full_text  = "\n".join(sections)
    full_text += f"\n---\n*取得完了: {now.strftime('%Y-%m-%d %H:%M')} | 合計 {grand_total} 件*\n"

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(full_text)

    print()
    print("=" * 50)
    print(f"✅ 完了！合計 {grand_total} 件を保存しました")
    print(f"📄 {output_path}")
    print()
    print("【次のステップ】Coworkを開き、abstracts_*.md を開いて")
    print("処理したいテーマのプロンプトをコピーしてClaudeに貼り付けてください。")
    print()
    print("Google Docは自動的に以下の2部構成で作成されます:")
    print(f"  例: {now.strftime('%Y-%m')}_気管支喘息_abstract10本")
    print("  　 第1部: 日本語要約（①〜⑤）")
    print("  　 第2部: 英語 Abstract（full text）")


if __name__ == "__main__":
    main()
