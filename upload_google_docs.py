#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Google Docs uploader placeholder
================================

このスクリプトは、ai_selected のHTMLをGoogle Docsへアップロードする工程の
入口です。実際の自動アップロードにはGoogle Drive APIのOAuth認証情報が必要です。

Codexアプリ内ではGoogle Drive連携を使ってアップロードできますが、Macの
ダブルクリック.commandから同じ連携を直接呼び出すことはできません。
"""

import argparse
import os
import sys


def parse_args():
    parser = argparse.ArgumentParser(
        description="ai_selected のHTMLファイル一覧を表示します。Google Docs自動アップロードにはGoogle OAuth設定が必要です。"
    )
    parser.add_argument(
        "path",
        nargs="?",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai_selected"),
        help="アップロード対象のHTMLファイルまたはフォルダ",
    )
    return parser.parse_args()


def find_html_files(path):
    if os.path.isfile(path) and path.endswith(".html"):
        return [path]
    html_files = []
    for root, _, files in os.walk(path):
        for name in files:
            if name.endswith(".html"):
                html_files.append(os.path.join(root, name))
    return sorted(html_files)


def main():
    args = parse_args()
    path = os.path.abspath(args.path)
    files = find_html_files(path)

    if not files:
        print(f"HTMLファイルが見つかりません: {path}")
        return 1

    print("Google Docsへアップロード候補のHTML:")
    for file_path in files:
        print(f"- {file_path}")

    print()
    print("現時点では、このMac単体でのGoogle Docs自動保存にはGoogle OAuth設定が必要です。")
    print("Codex上では、これらのHTMLをGoogle Drive連携でGoogle Docsに変換アップロードできます。")
    print("ダブルクリックだけで完結させる場合は、次にGoogle Drive API認証を設定します。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
