#!/usr/bin/env python3
"""Google本人OAuthを一度だけ行い、GitHub Secret用JSONを出力する。"""

import argparse
import json
import os
import sys
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build


SCOPES = [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/gmail.send",
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("client_secret_json", help="Google CloudのDesktop OAuth client JSON")
    parser.add_argument("--root-name", default="PubMed_Automation_Root")
    parser.add_argument("--output", default="google_authorized_user.json")
    args = parser.parse_args()
    flow = InstalledAppFlow.from_client_secrets_file(args.client_secret_json, SCOPES)
    credentials = flow.run_local_server(port=0, access_type="offline", prompt="consent")
    drive = build("drive", "v3", credentials=credentials, cache_discovery=False)
    root = drive.files().create(
        body={"name": args.root_name, "mimeType": "application/vnd.google-apps.folder"},
        fields="id",
    ).execute()
    authorized_user = json.dumps({
        "token": credentials.token,
        "refresh_token": credentials.refresh_token,
        "token_uri": credentials.token_uri,
        "client_id": credentials.client_id,
        "client_secret": credentials.client_secret,
        "scopes": list(credentials.scopes or SCOPES),
    }, ensure_ascii=False)
    output = Path(args.output).resolve()
    output.write_text(authorized_user + "\n", encoding="utf-8")
    os.chmod(output, 0o600)
    print(f"GOOGLE_AUTHORIZED_USER_JSONを保存しました: {output}")
    print(f"GOOGLE_DRIVE_ROOT_FOLDER_ID={root['id']}", file=sys.stderr)


if __name__ == "__main__":
    main()
