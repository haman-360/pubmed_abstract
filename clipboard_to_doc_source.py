#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Clipboard to Google Docs source
===============================
ChatGPTの回答をコピーしたあと、クリップボード内容をGoogle Docsへ
アップロードしやすいHTML/TXTとして保存します。
"""

import argparse
import html
import os
import re
import subprocess
from datetime import datetime

from pubmed_fetch import SEARCHES


BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def safe_filename(text):
    text = re.sub(r'[\\/:*?"<>|]+', "_", text)
    text = re.sub(r"\s+", "_", text).strip("._ ")
    return text or "ChatGPT出力"


def read_clipboard():
    try:
        result = subprocess.run(["pbpaste"], capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError:
        return ""
    return result.stdout.strip()


def is_markdown_table_separator(line):
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    if not cells:
        return False
    return all(re.fullmatch(r":?-{3,}:?", cell or "") for cell in cells)


def is_markdown_table_start(lines, index):
    if index + 1 >= len(lines):
        return False
    return "|" in lines[index] and is_markdown_table_separator(lines[index + 1])


def split_markdown_row(line):
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def render_markdown_table(lines, start):
    header = split_markdown_row(lines[start])
    rows = []
    index = start + 2
    while index < len(lines) and "|" in lines[index].strip():
        row = split_markdown_row(lines[index])
        if len(row) == len(header):
            rows.append(row)
            index += 1
            continue
        break

    head_html = "".join(f"<th>{html.escape(cell)}</th>" for cell in header)
    body_rows = []
    for row in rows:
        cells = "".join(f"<td>{html.escape(cell)}</td>" for cell in row)
        body_rows.append(f"<tr>{cells}</tr>")

    table_html = "\n".join([
        "<table>",
        f"<thead><tr>{head_html}</tr></thead>",
        "<tbody>",
        "\n".join(body_rows),
        "</tbody>",
        "</table>",
    ])
    return table_html, index


def paragraph_to_html(paragraph_lines):
    text = "\n".join(paragraph_lines).strip()
    if not text:
        return ""
    if text.startswith("### "):
        return f"<h3>{html.escape(text[4:].strip())}</h3>"
    if text.startswith("## "):
        return f"<h2>{html.escape(text[3:].strip())}</h2>"
    if text.startswith("# "):
        return f"<h2>{html.escape(text[2:].strip())}</h2>"
    return f"<p>{html.escape(text).replace(chr(10), '<br>')}</p>"


def markdownish_text_to_html(text):
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    html_parts = []
    paragraph = []
    index = 0

    while index < len(lines):
        line = lines[index]

        if is_markdown_table_start(lines, index):
            if paragraph:
                html_parts.append(paragraph_to_html(paragraph))
                paragraph = []
            table_html, index = render_markdown_table(lines, index)
            html_parts.append(table_html)
            continue

        if line.strip() == "":
            if paragraph:
                html_parts.append(paragraph_to_html(paragraph))
                paragraph = []
            index += 1
            continue

        paragraph.append(line)
        index += 1

    if paragraph:
        html_parts.append(paragraph_to_html(paragraph))

    return "\n".join(part for part in html_parts if part)


def text_to_html(title, text):
    body_html = markdownish_text_to_html(text)
    return f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>{html.escape(title)}</title>
  <style>
    body {{ font-family: Arial, "Hiragino Sans", "Yu Gothic", sans-serif; line-height: 1.65; color: #222; }}
    h1, h2, h3 {{ line-height: 1.3; }}
    .meta {{ color: #555; }}
    table {{ border-collapse: collapse; width: 100%; margin: 16px 0 28px; }}
    th, td {{ border: 1px solid #bbb; padding: 6px 8px; vertical-align: top; }}
    th {{ background: #f1f3f5; }}
  </style>
</head>
<body>
  <h1>{html.escape(title)}</h1>
  <p class="meta">作成日時: {datetime.now().strftime('%Y-%m-%d %H:%M')}</p>
  <div class="content">
{body_html}
  </div>
</body>
</html>
"""


def parse_args():
    parser = argparse.ArgumentParser(description="クリップボードのChatGPT出力をHTML/TXTに保存します。")
    parser.add_argument("--title", default="", help="保存ファイル名・Google Docsタイトル")
    parser.add_argument("--topic", default="", help="テーマ名または検索名。例: ped_psycho_update / 小児心身症")
    parser.add_argument("--week", default="", help="週次ファイル用の週番号。例: 1")
    parser.add_argument("--output-dir", default=os.path.join(BASE_DIR, "chatgpt_outputs"))
    return parser.parse_args()


def find_topic(topic):
    if not topic:
        return None
    needle = topic.casefold()
    for search in SEARCHES:
        values = [
            search["name"],
            search["label"],
            search.get("filename_label", ""),
            *search.get("aliases", []),
        ]
        if any(needle in value.casefold() for value in values):
            return search
    return None


def build_title(args, now):
    if args.title.strip():
        return args.title.strip()

    search = find_topic(args.topic)
    if not search:
        return f"{now.strftime('%Y-%m-%d')}_ChatGPT出力"

    label = search.get("filename_label", search["label"])
    if args.week.strip():
        return f"{now.strftime('%Y-%m')}_w{args.week.strip()}_{label}_abstract10本"
    return f"{now.strftime('%Y-%m')}_{label}_abstract10本"


def unique_output_paths(out_dir, base):
    txt_path = os.path.join(out_dir, f"{base}.txt")
    html_path = os.path.join(out_dir, f"{base}.html")
    if not os.path.exists(txt_path) and not os.path.exists(html_path):
        return txt_path, html_path

    number = 2
    while True:
        candidate_base = f"{base}_{number}"
        txt_path = os.path.join(out_dir, f"{candidate_base}.txt")
        html_path = os.path.join(out_dir, f"{candidate_base}.html")
        if not os.path.exists(txt_path) and not os.path.exists(html_path):
            return txt_path, html_path
        number += 1


def main():
    args = parse_args()
    text = read_clipboard()
    if not text:
        print("クリップボードが空です。先にChatGPTの回答をコピーしてください。")
        return 1

    now = datetime.now()
    title = build_title(args, now)
    out_dir = os.path.join(os.path.abspath(args.output_dir), now.strftime("%Y%m"))
    os.makedirs(out_dir, exist_ok=True)

    base = safe_filename(title)
    txt_path, html_path = unique_output_paths(out_dir, base)

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(text_to_html(title, text))

    print("保存しました:")
    print(f"- {txt_path}")
    print(f"- {html_path}")
    print()
    print("Google Driveにアップロードする場合は、HTMLファイルを使うとGoogle Docs化しやすいです。")
    subprocess.run(["open", out_dir], check=False, stderr=subprocess.DEVNULL)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
