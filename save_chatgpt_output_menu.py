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


def ask_yes_no(prompt, default=False):
    suffix = "Y/n" if default else "y/N"
    value = input(f"{prompt} [{suffix}]: ").strip().lower()
    if not value:
        return default
    return value in ("y", "yes")


def topic_choices():
    return [
        (search["label"], search["name"], search.get("frequency", "monthly"))
        for search in SEARCHES
    ]


def build_save_args(choices):
    print("テーマを選んでください。")
    for i, (label, _, frequency) in enumerate(choices, 1):
        suffix = "（週次）" if frequency == "weekly" and "週次" not in label else ""
        print(f"{i}. {label}{suffix}")
    print(f"{len(choices) + 1}. 手入力タイトル")
    print(f"{len(choices) + 2}. 終了")

    number = ask_number("番号を入力してください: ", 1, len(choices) + 2)
    if number == len(choices) + 2:
        return None

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
    return args


def save_one(choices):
    print()
    print("保存したいChatGPT回答をコピーしてからReturnキーを押してください。")
    input("準備できたらReturn: ")
    print()
    args = build_save_args(choices)
    if args is None:
        return None
    sys.stdout.flush()

    print()
    result = subprocess.run(args, cwd=BASE_DIR, check=False)
    return result.returncode == 0


def main():
    choices = topic_choices()
    saved_count = 0

    print("ChatGPT出力をGoogle Docs用に保存")
    print("================================")
    print()
    print("複数テーマを連続して保存できます。")

    while True:
        result = save_one(choices)
        if result is None:
            break
        if result:
            saved_count += 1

        print()
        if not ask_yes_no("続けて別のChatGPT回答を保存しますか？", default=True):
            break
        print()

    print()
    print(f"保存処理を終了します。成功: {saved_count}件")
    input("終了するにはReturnキーを押してください。")


if __name__ == "__main__":
    main()
