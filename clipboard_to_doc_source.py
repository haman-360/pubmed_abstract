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


def text_to_html(title, text):
    escaped = html.escape(text)
    escaped = escaped.replace("\n", "<br>\n")
    return f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>{html.escape(title)}</title>
  <style>
    body {{ font-family: Arial, "Hiragino Sans", "Yu Gothic", sans-serif; line-height: 1.65; color: #222; }}
    h1 {{ line-height: 1.3; }}
    .meta {{ color: #555; }}
    .content {{ white-space: normal; }}
  </style>
</head>
<body>
  <h1>{html.escape(title)}</h1>
  <p class="meta">作成日時: {datetime.now().strftime('%Y-%m-%d %H:%M')}</p>
  <div class="content">
{escaped}
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
    txt_path = os.path.join(out_dir, f"{base}.txt")
    html_path = os.path.join(out_dir, f"{base}.html")

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
