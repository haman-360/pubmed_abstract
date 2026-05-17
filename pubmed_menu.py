#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PubMed menu launcher
====================
ダブルクリック用の入口メニューです。
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


def run_command(args):
    print()
    print("実行します:")
    print(" ".join(args))
    print()
    sys.stdout.flush()
    subprocess.run(args, cwd=BASE_DIR, check=False)


def open_output_folder(mode):
    folder_by_mode = {
        "ai": "ai_selected",
        "paste": "chatgpt_paste",
        "fetch": "google_docs",
    }
    folder = folder_by_mode.get(mode, "google_docs")
    path = os.path.join(BASE_DIR, folder)
    if os.path.exists(path):
        subprocess.run(["open", path], check=False, stderr=subprocess.DEVNULL)


def topic_menu():
    choices = [
        ("月次テーマすべて", ["--frequency", "monthly"]),
        ("週次: 小児感染症", ["--frequency", "weekly"]),
        ("全テーマすべて（月次 + 週次）", ["--frequency", "all"]),
    ]
    for search in SEARCHES:
        choices.append((search["label"], ["--topic", search["name"]]))

    print()
    print("どのテーマを実行しますか？")
    for i, (label, _) in enumerate(choices, 1):
        print(f"{i}. {label}")

    number = ask_number("番号を入力してください: ", 1, len(choices))
    return choices[number - 1]


def main():
    print("PubMed Abstract 作成メニュー")
    print("==========================")
    print()
    print("作成方法を選んでください。")
    print("1. Abstract抽出のみ（AI選定なし）")
    print("2. AIで10本を選定（日本語評価 + 英語abstract集）")
    print("3. ChatGPT Thinking貼付用txtを作成してコピー（API不要）")
    mode_number = ask_number("番号を入力してください: ", 1, 3)
    mode = {1: "fetch", 2: "ai", 3: "paste"}[mode_number]

    label, topic_args = topic_menu()
    script = "pubmed_ai_select.py" if mode == "ai" else "pubmed_fetch.py"
    args = [sys.executable, os.path.join(BASE_DIR, script), *topic_args]
    if mode == "paste":
        args.extend(["--paste-text-only", "--copy-paste-text"])

    print()
    print(f"選択: {label}")
    if mode == "ai":
        print("AI選定を使います。OPENAI_API_KEY が必要です。")
    elif mode == "paste":
        print("ChatGPT Thinking貼付用txtを作成し、クリップボードへコピーします。")

    run_command(args)
    open_output_folder(mode)

    print()
    print("完了しました。")
    input("終了するにはReturnキーを押してください。")


if __name__ == "__main__":
    main()
