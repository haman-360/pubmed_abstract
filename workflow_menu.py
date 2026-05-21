#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PubMed workflow menu
====================
PubMed取得、ChatGPT貼付用ファイル作成、ChatGPT出力保存、
Google Docsアップロード準備、処理済みファイルのアーカイブを
1つの入口にまとめたダブルクリック用メニューです。
"""

import os
import shlex
import shutil
import subprocess
import sys
from datetime import datetime

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


def pause(message="続けるにはReturnキーを押してください。"):
    input(message)


def run_command(args):
    print()
    print("実行します。")
    print(" ".join(args))
    print()
    sys.stdout.flush()
    return subprocess.run(args, cwd=BASE_DIR, check=False).returncode


def open_folder(path):
    if os.path.exists(path):
        subprocess.run(["open", path], check=False, stderr=subprocess.DEVNULL)


def current_month_dir(folder):
    return os.path.join(BASE_DIR, folder, datetime.now().strftime("%Y%m"))


def split_input_paths(text):
    text = text.strip()
    if not text:
        return []
    try:
        return shlex.split(text)
    except ValueError:
        return [part for part in text.split() if part]


def common_folder(paths):
    existing_paths = [path for path in paths if os.path.exists(path)]
    if not existing_paths:
        return BASE_DIR
    folders = [path if os.path.isdir(path) else os.path.dirname(path) for path in existing_paths]
    return os.path.commonpath(folders)


def print_header():
    print("PubMed ワークフロー")
    print("===================")
    print()
    print("順番の目安:")
    print("1. PubMedから直近の論文を集め、ChatGPT貼付用txtを作る")
    print("2. ChatGPTで1テーマずつ選定し、回答をコピーする")
    print("3. コピーしたChatGPT回答をGoogle Docs用HTML/TXTに保存する")
    print("4. HTMLをGoogle Driveへアップロードする候補として確認する")
    print("5. 終わったHTML/TXTをarchiveへ移動する")
    print()


def topic_choices():
    choices = [
        ("月次テーマすべて", ["--frequency", "monthly"]),
        ("週次: 小児感染症", ["--frequency", "weekly"]),
        ("全テーマすべて（月次 + 週次）", ["--frequency", "all"]),
    ]
    for search in SEARCHES:
        choices.append((search["label"], ["--topic", search["name"]]))
    return choices


def choose_pubmed_scope():
    choices = topic_choices()
    print()
    print("どのテーマを取得しますか？")
    for i, (label, _) in enumerate(choices, 1):
        print(f"{i}. {label}")
    number = ask_number("番号を入力してください: ", 1, len(choices))
    return choices[number - 1]


def create_chatgpt_paste_files():
    label, topic_args = choose_pubmed_scope()
    print()
    print(f"選択: {label}")
    print("PubMedから取得し、ChatGPTへ貼り付けやすいtxtを作ります。")
    print("完了後、内容をクリップボードにもコピーします。")

    args = [
        sys.executable,
        os.path.join(BASE_DIR, "pubmed_fetch.py"),
        *topic_args,
        "--paste-text-only",
        "--copy-paste-text",
    ]
    code = run_command(args)
    open_folder(current_month_dir("chatgpt_paste"))
    if code == 0:
        print()
        print("次はChatGPTに貼り付け、1テーマずつ選定してください。")
    return code


def save_chatgpt_output():
    print()
    print("ChatGPTの回答を保存します。")
    print("先にChatGPTの最終回答をコピーしておいてください。")
    pause("コピーできたらReturnキーを押してください。")
    code = run_command([sys.executable, os.path.join(BASE_DIR, "save_chatgpt_output_menu.py")])
    open_folder(current_month_dir("chatgpt_outputs"))
    return code


def upload_candidate_menu():
    now_month = datetime.now().strftime("%Y%m")
    choices = [
        ("ChatGPT回答から作ったHTML（通常はこちら）", os.path.join(BASE_DIR, "chatgpt_outputs", now_month)),
        ("アーカイブ済みChatGPT回答HTML", os.path.join(BASE_DIR, "archive", "processed", now_month)),
        ("PubMed抽出HTML", os.path.join(BASE_DIR, "google_docs", now_month)),
        ("APIでAI選定したHTML", os.path.join(BASE_DIR, "ai_selected", now_month)),
        ("フォルダ/ファイルを手入力", ""),
    ]

    print()
    print("Google Docsへアップロードする候補HTMLを確認します。")
    for i, (label, path) in enumerate(choices, 1):
        suffix = f" - {path}" if path else ""
        print(f"{i}. {label}{suffix}")
    number = ask_number("番号を入力してください: ", 1, len(choices))
    _, path = choices[number - 1]
    paths = [path] if path else []
    if not path:
        print("複数ある場合は、スペース区切りで貼り付けてください。")
        raw_paths = input("HTMLファイルまたはフォルダのパスを入力してください: ")
        paths = split_input_paths(raw_paths)
        if not paths:
            print("パスが入力されていません。")
            return 1

    args = [sys.executable, os.path.join(BASE_DIR, "upload_google_docs.py"), *paths, "--archive-note"]
    print()
    print("この時点では候補確認だけです。")
    print("実際にアップロードする場合、初回だけGoogleログインが開きます。")
    print("要求する権限は低リスクの drive.file のみです。")
    print("注意: credentials.json と token_drive_file.json は共有しないでください。")
    if ask_yes_no("実際にGoogle Docsへアップロードしますか？", default=False):
        args.append("--upload")

    code = run_command(args)
    open_folder(common_folder(paths))
    return code


def files_to_archive(source_dir):
    if not os.path.isdir(source_dir):
        return []
    targets = []
    for root, _, files in os.walk(source_dir):
        for name in files:
            if name.endswith((".txt", ".html")):
                targets.append(os.path.join(root, name))
    return sorted(targets)


def archive_processed_files():
    now_month = datetime.now().strftime("%Y%m")
    choices = [
        ("ChatGPT回答HTML/TXT", os.path.join(BASE_DIR, "chatgpt_outputs", now_month)),
        ("ChatGPT貼付用TXT", os.path.join(BASE_DIR, "chatgpt_paste", now_month)),
        ("PubMed抽出HTML", os.path.join(BASE_DIR, "google_docs", now_month)),
        ("APIでAI選定したHTML/TXT", os.path.join(BASE_DIR, "ai_selected", now_month)),
    ]

    print()
    print("処理済みファイルをarchiveへ移動します。")
    for i, (label, path) in enumerate(choices, 1):
        print(f"{i}. {label} - {path}")
    number = ask_number("番号を入力してください: ", 1, len(choices))
    label, source_dir = choices[number - 1]

    targets = files_to_archive(source_dir)
    if not targets:
        print(f"移動するHTML/TXTがありません: {source_dir}")
        return 0

    print()
    print(f"{label}: {len(targets)}個のファイルを移動します。")
    for path in targets[:20]:
        print(f"- {os.path.basename(path)}")
    if len(targets) > 20:
        print(f"...ほか {len(targets) - 20} 個")

    if not ask_yes_no("本当にarchiveへ移動しますか？", default=False):
        print("移動を中止しました。")
        return 0

    archive_dir = os.path.join(BASE_DIR, "archive", "processed", now_month, os.path.basename(os.path.normpath(source_dir)))
    os.makedirs(archive_dir, exist_ok=True)

    moved = 0
    for path in targets:
        dest = os.path.join(archive_dir, os.path.basename(path))
        if os.path.exists(dest):
            stem, ext = os.path.splitext(os.path.basename(path))
            dest = os.path.join(archive_dir, f"{stem}_{datetime.now().strftime('%Y%m%d_%H%M%S')}{ext}")
        shutil.move(path, dest)
        moved += 1

    print(f"{moved}個のファイルを移動しました。")
    open_folder(archive_dir)
    return 0


def guided_workflow():
    print()
    print("一連の作業を順番に進めます。")
    print("ChatGPTでの選定だけは手作業なので、途中で止まって待ちます。")
    code = create_chatgpt_paste_files()
    if code != 0:
        return code

    print()
    print("ChatGPTで1テーマ分の選定が終わったら、その回答をコピーしてください。")
    if ask_yes_no("今すぐChatGPT回答の保存へ進みますか？", default=True):
        save_chatgpt_output()

    if ask_yes_no("Google Docsアップロード候補の確認へ進みますか？", default=True):
        upload_candidate_menu()

    if ask_yes_no("処理済みHTML/TXTをarchiveへ移動しますか？", default=False):
        archive_processed_files()
    return 0


def main():
    while True:
        print_header()
        print("メニュー:")
        print("1. 一連の作業を順番に進める")
        print("2. PubMed取得 + ChatGPT貼付用txt作成")
        print("3. ChatGPT回答をGoogle Docs用HTML/TXTに保存")
        print("4. Google Docsアップロード候補HTMLを確認（複数ファイル対応）")
        print("5. 処理済みHTML/TXTをarchiveへ移動")
        print("6. 旧PubMed作成メニューを開く")
        print("7. 旧ChatGPT保存メニューを開く")
        print("8. 終了")
        number = ask_number("番号を入力してください: ", 1, 8)

        if number == 1:
            guided_workflow()
        elif number == 2:
            create_chatgpt_paste_files()
        elif number == 3:
            save_chatgpt_output()
        elif number == 4:
            upload_candidate_menu()
        elif number == 5:
            archive_processed_files()
        elif number == 6:
            run_command([sys.executable, os.path.join(BASE_DIR, "pubmed_menu.py")])
        elif number == 7:
            run_command([sys.executable, os.path.join(BASE_DIR, "save_chatgpt_output_menu.py")])
        else:
            break

        print()
        pause()
        print()


if __name__ == "__main__":
    main()
