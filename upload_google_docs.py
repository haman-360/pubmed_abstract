#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Google Docs uploader placeholder
================================

HTMLをGoogle Driveへアップロードし、Google Docs形式に変換します。
OAuth権限は、このアプリが作成・選択したファイルだけを扱う drive.file に限定します。
"""

import argparse
import os
import sys
import warnings


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VENDOR_DIR = os.path.join(BASE_DIR, "vendor", "google_drive")
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
DEFAULT_CREDENTIALS = os.path.join(BASE_DIR, "credentials.json")
DEFAULT_TOKEN = os.path.join(BASE_DIR, "token_drive_file.json")

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL.*")


def parse_args():
    parser = argparse.ArgumentParser(
        description="HTMLファイルをGoogle Docs形式に変換アップロードします。"
    )
    parser.add_argument(
        "paths",
        nargs="*",
        help="アップロード対象のHTMLファイルまたはフォルダ。複数指定できます。",
    )
    parser.add_argument(
        "--upload",
        action="store_true",
        help="候補表示だけでなく、実際にGoogle Docsへアップロードする。",
    )
    parser.add_argument(
        "--credentials",
        default=DEFAULT_CREDENTIALS,
        help="Google Cloudで作成したOAuthクライアントJSON。",
    )
    parser.add_argument(
        "--token",
        default=DEFAULT_TOKEN,
        help="初回認証後に保存するトークンJSON。",
    )
    parser.add_argument(
        "--folder-id",
        default="",
        help="アップロード先Google DriveフォルダID。空欄ならマイドライブ直下。",
    )
    parser.add_argument(
        "--archive-note",
        action="store_true",
        help="確認後にworkflow_menu.pyのアーカイブ機能を使えることを表示する。",
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


def find_html_files_many(paths):
    html_files = []
    missing = []
    for path in paths:
        files = find_html_files(os.path.abspath(path))
        if files:
            html_files.extend(files)
        else:
            missing.append(os.path.abspath(path))

    seen = set()
    unique_files = []
    for file_path in html_files:
        if file_path not in seen:
            seen.add(file_path)
            unique_files.append(file_path)
    return sorted(unique_files), missing


def doc_title_from_html_path(path):
    return os.path.splitext(os.path.basename(path))[0]


def print_dependency_help():
    print("Google Drive API用ライブラリがまだ入っていません。")
    print()
    print("一度だけ以下を実行してください:")
    print(f"  python3 -m pip install --target {VENDOR_DIR} -r {os.path.join(BASE_DIR, 'requirements-google-drive.txt')}")
    print()
    print("または、Finderで以下をダブルクリックしてください:")
    print(f"  {os.path.join(BASE_DIR, 'archive', 'launchers', 'GoogleDrive依存ライブラリをインストール.command')}")


def import_google_libraries():
    if os.path.isdir(VENDOR_DIR) and VENDOR_DIR not in sys.path:
        sys.path.insert(0, VENDOR_DIR)
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaFileUpload
    except ModuleNotFoundError:
        print_dependency_help()
        return None
    return {
        "Request": Request,
        "Credentials": Credentials,
        "InstalledAppFlow": InstalledAppFlow,
        "build": build,
        "MediaFileUpload": MediaFileUpload,
    }


def print_credentials_help(credentials_path):
    print("Google OAuth認証ファイルが見つかりません。")
    print()
    print("必要なファイル:")
    print(f"  {credentials_path}")
    print()
    print("Google Cloud Consoleで、Drive APIを有効化し、")
    print("OAuthクライアントIDの種類を「デスクトップアプリ」で作成して、")
    print("ダウンロードしたJSONを credentials.json という名前でこのフォルダに置いてください。")
    print()
    print("注意: credentials.json と token_drive_file.json は共有しないでください。")


def get_drive_service(args, libs):
    credentials_path = os.path.abspath(args.credentials)
    token_path = os.path.abspath(args.token)
    if not os.path.exists(credentials_path):
        print_credentials_help(credentials_path)
        return None

    Request = libs["Request"]
    Credentials = libs["Credentials"]
    InstalledAppFlow = libs["InstalledAppFlow"]
    build = libs["build"]

    creds = None
    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            print("初回認証を開始します。ブラウザでGoogleアカウントを選んで許可してください。")
            print("要求する権限は drive.file のみです。")
            flow = InstalledAppFlow.from_client_secrets_file(credentials_path, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(token_path, "w", encoding="utf-8") as f:
            f.write(creds.to_json())
        print(f"認証トークンを保存しました: {token_path}")
        print("注意: このtokenファイルは共有しないでください。")

    return build("drive", "v3", credentials=creds)


def upload_files(args, files):
    libs = import_google_libraries()
    if libs is None:
        return 1

    service = get_drive_service(args, libs)
    if service is None:
        return 1

    print()
    print("Google Docsへアップロードします。")
    print("使用するOAuth権限: drive.file")
    print()

    uploaded = []
    failed = []
    MediaFileUpload = libs["MediaFileUpload"]

    for html_path in files:
        try:
            title = doc_title_from_html_path(html_path)
            metadata = {
                "name": title,
                "mimeType": "application/vnd.google-apps.document",
            }
            if args.folder_id:
                metadata["parents"] = [args.folder_id]

            media = MediaFileUpload(html_path, mimetype="text/html", resumable=False)
            result = service.files().create(
                body=metadata,
                media_body=media,
                fields="id,name,webViewLink",
            ).execute()
            uploaded.append(result)
            print(f"✅ {result.get('name')}")
            print(f"   {result.get('webViewLink')}")
        except Exception as e:
            failed.append((html_path, e))
            print(f"❌ {html_path}")
            print(f"   {e}")

    print()
    print(f"アップロード完了: 成功 {len(uploaded)} 件 / 失敗 {len(failed)} 件")
    return 0 if not failed else 1


def main():
    args = parse_args()
    paths = args.paths or [os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai_selected")]
    files, missing = find_html_files_many(paths)

    if not files:
        print("HTMLファイルが見つかりません。")
        for path in missing:
            print(f"- {path}")
        return 1

    print("Google Docsへアップロード候補のHTML:")
    for file_path in files:
        print(f"- {file_path}")
    if missing:
        print()
        print("HTMLが見つからなかった指定:")
        for path in missing:
            print(f"- {path}")

    print()
    print(f"合計 {len(files)} 個のHTMLファイルが見つかりました。")

    if args.upload:
        return upload_files(args, files)

    print()
    print("まだアップロードは実行していません。")
    print("実際にGoogle Docsへ作成する場合は --upload を付けて実行します。")
    if args.archive_note:
        print("アップロード後は、PubMedワークフローの「処理済みHTML/TXTをarchiveへ移動」を使えます。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
