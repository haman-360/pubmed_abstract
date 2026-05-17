#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ChatGPT output save menu
========================
ChatGPTの回答をコピーしたあと、テーマ選択で自動タイトル保存します。
"""

import os
import subprocess
import sys

from pubmed_fetch import SEARCHES


BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def ask_number(prompt, min_value, max_value):
    while True:
        value = input(prompt).strip()
        if value.isdigit():
            number = int(value)
            if min_value <= number <= max_value:
                return number
        print(f"{min_value}〜{max_value} の番号を入力してください。")


def main():
    choices = []
    for search in SEARCHES:
        choices.append((search["label"], search["name"], search.get("frequency", "monthly")))

    print("ChatGPT出力をGoogle Docs用に保存")
    print("================================")
    print()
    print("先にChatGPTの回答をコピーしておいてください。")
    print()
    print("テーマを選んでください。")
    for i, (label, _, frequency) in enumerate(choices, 1):
        suffix = "（週次）" if frequency == "weekly" and "週次" not in label else ""
        print(f"{i}. {label}{suffix}")
    print(f"{len(choices) + 1}. 手入力タイトル")

    number = ask_number("番号を入力してください: ", 1, len(choices) + 1)

    args = [sys.executable, os.path.join(BASE_DIR, "clipboard_to_doc_source.py")]
    if number == len(choices) + 1:
        title = input("タイトル: ").strip()
        args.extend(["--title", title])
    else:
        label, topic, frequency = choices[number - 1]
        args.extend(["--topic", topic])
        if frequency == "weekly":
            week = input("週番号を入力してください（例: 1）。空欄なら1: ").strip() or "1"
            args.extend(["--week", week])
        print(f"保存タイトルは {label} から自動生成します。")
    sys.stdout.flush()

    print()
    subprocess.run(args, cwd=BASE_DIR, check=False)
    print()
    input("終了するにはReturnキーを押してください。")


if __name__ == "__main__":
    main()
