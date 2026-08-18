#!/usr/bin/env python3
"""OpenAI Batch APIとGoogle Workspace APIの小さなアダプター。"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import urllib.error
import urllib.request
import uuid
from email.message import EmailMessage
from typing import Any


SCORE_TABLE_HEADING = "【第3部：候補論文スコア一覧】"
SCORE_TABLE_HEADERS = ["PMID", "タイトル", "総合スコア", "役立つか", "短いメモ"]


def split_score_table(text: str) -> tuple[str, list[list[str]] | None]:
    """Separate the final score section into Google Docs table data."""
    lines = text.splitlines()
    try:
        heading_index = lines.index(SCORE_TABLE_HEADING)
        header_index = next(
            index
            for index in range(heading_index + 1, len(lines))
            if lines[index].strip()
        )
    except (ValueError, StopIteration):
        return text, None

    header = [cell.strip() for cell in lines[header_index].split(" | ")]
    if header != SCORE_TABLE_HEADERS:
        return text, None

    rows = [header]
    for line in lines[header_index + 1:]:
        if not line.strip():
            continue
        cells = [cell.strip() for cell in line.split(" | ")]
        if len(cells) != len(SCORE_TABLE_HEADERS):
            return text, None
        rows.append(cells)

    # Keep the heading in the ordinary text flow and place the native table below it.
    prefix = "\n".join(lines[:header_index]).rstrip() + "\n"
    return prefix, rows


def _table_cells(table_element: dict[str, Any]) -> list[list[dict[str, Any]]]:
    return [
        row.get("tableCells", [])
        for row in table_element.get("table", {}).get("tableRows", [])
    ]


def _structural_text(content: list[dict[str, Any]]) -> str:
    """Return plain text from Google Docs structural elements."""
    parts: list[str] = []
    for item in content:
        paragraph = item.get("paragraph", {})
        for element in paragraph.get("elements", []):
            parts.append(element.get("textRun", {}).get("content", ""))
    return "".join(parts).rstrip("\n")


def _table_text_rows(table_element: dict[str, Any]) -> list[list[str]]:
    return [
        [_structural_text(cell.get("content", [])) for cell in row]
        for row in _table_cells(table_element)
    ]


class OpenAIBatchClient:
    API_ROOT = "https://api.openai.com/v1"

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        if not self.api_key:
            raise RuntimeError("OPENAI_API_KEYが設定されていません。")

    def _request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        content_type: str | None = None,
        expect_bytes: bool = False,
    ) -> Any:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(
            f"{self.API_ROOT}{path}", data=body, method=method, headers=headers
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                raw = response.read()
                if expect_bytes:
                    return raw
                if response.headers.get("Content-Type", "").split(";", 1)[0] == "application/json":
                    return json.loads(raw.decode("utf-8"))
                return raw
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OpenAI API HTTP {exc.code}: {detail}") from exc

    def upload_jsonl(self, filename: str, content: bytes) -> dict[str, Any]:
        boundary = f"----pubmed-{uuid.uuid4().hex}"
        parts = [
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nbatch\r\n".encode(),
            (
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                f"filename=\"{filename}\"\r\nContent-Type: application/jsonl\r\n\r\n"
            ).encode(),
            content,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
        return self._request(
            "POST", "/files", b"".join(parts), f"multipart/form-data; boundary={boundary}"
        )

    def create_batch(self, input_file_id: str, completion_window: str, metadata: dict[str, str]) -> dict[str, Any]:
        payload = {
            "input_file_id": input_file_id,
            "endpoint": "/v1/responses",
            "completion_window": completion_window,
            "metadata": metadata,
        }
        return self._request("POST", "/batches", json.dumps(payload).encode(), "application/json")

    def retrieve_batch(self, batch_id: str) -> dict[str, Any]:
        return self._request("GET", f"/batches/{batch_id}")

    def download_file(self, file_id: str) -> bytes:
        return self._request("GET", f"/files/{file_id}/content", expect_bytes=True)


class GoogleWorkspaceClient:
    def __init__(self, authorized_user_json: str | None = None):
        try:
            from google.oauth2.credentials import Credentials
            from googleapiclient.discovery import build
        except ImportError as exc:
            raise RuntimeError("Google API依存パッケージがありません。requirements-automation.txtを導入してください。") from exc

        raw = authorized_user_json or os.environ.get("GOOGLE_AUTHORIZED_USER_JSON", "")
        if not raw:
            raise RuntimeError("GOOGLE_AUTHORIZED_USER_JSONが設定されていません。")
        info = json.loads(raw)
        scopes = [
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/gmail.send",
        ]
        credentials = Credentials.from_authorized_user_info(info, scopes=scopes)
        self.drive = build("drive", "v3", credentials=credentials, cache_discovery=False)
        self.docs = build("docs", "v1", credentials=credentials, cache_discovery=False)
        self.gmail = build("gmail", "v1", credentials=credentials, cache_discovery=False)

    def find_child(self, parent_id: str, name: str, mime_type: str | None = None) -> dict[str, Any] | None:
        escaped = name.replace("\\", "\\\\").replace("'", "\\'")
        clauses = [f"'{parent_id}' in parents", f"name = '{escaped}'", "trashed = false"]
        if mime_type:
            clauses.append(f"mimeType = '{mime_type}'")
        result = self.drive.files().list(
            q=" and ".join(clauses),
            fields="files(id,name,mimeType,webViewLink,modifiedTime)",
            pageSize=2,
        ).execute()
        files = result.get("files", [])
        return files[0] if files else None

    def ensure_folder(self, parent_id: str, name: str) -> str:
        mime = "application/vnd.google-apps.folder"
        existing = self.find_child(parent_id, name, mime)
        if existing:
            return existing["id"]
        result = self.drive.files().create(
            body={"name": name, "mimeType": mime, "parents": [parent_id]},
            fields="id",
        ).execute()
        return result["id"]

    def create_or_update_blob(
        self,
        parent_id: str,
        name: str,
        content: bytes,
        mime_type: str = "application/json",
        file_id: str | None = None,
    ) -> dict[str, Any]:
        from googleapiclient.http import MediaIoBaseUpload
        import io

        media = MediaIoBaseUpload(io.BytesIO(content), mimetype=mime_type, resumable=False)
        if file_id:
            return self.drive.files().update(
                fileId=file_id, media_body=media, fields="id,name,mimeType,webViewLink,modifiedTime"
            ).execute()
        existing = self.find_child(parent_id, name)
        if existing:
            return self.drive.files().update(
                fileId=existing["id"], media_body=media,
                fields="id,name,mimeType,webViewLink,modifiedTime",
            ).execute()
        return self.drive.files().create(
            body={"name": name, "parents": [parent_id]},
            media_body=media,
            fields="id,name,mimeType,webViewLink,modifiedTime",
        ).execute()

    def download_blob(self, file_id: str) -> bytes:
        return self.drive.files().get_media(fileId=file_id).execute()

    def create_doc(self, parent_id: str, name: str, text: str) -> dict[str, Any]:
        mime = "application/vnd.google-apps.document"
        result = self.find_child(parent_id, name, mime)
        if not result:
            result = self.drive.files().create(
                body={"name": name, "mimeType": mime, "parents": [parent_id]},
                fields="id,name,webViewLink",
            ).execute()
        self.replace_doc_text(result["id"], text)
        if not result.get("webViewLink"):
            result["webViewLink"] = f"https://docs.google.com/document/d/{result['id']}/edit"
        return result

    def replace_doc_text(self, file_id: str, text: str) -> None:
        document = self.docs.documents().get(documentId=file_id).execute()
        content = document.get("body", {}).get("content", [])
        end_index = max((item.get("endIndex", 1) for item in content), default=1)
        body_text, score_table = split_score_table(text)
        requests = []
        if end_index > 2:
            requests.append({"deleteContentRange": {"range": {"startIndex": 1, "endIndex": end_index - 1}}})
        requests.append({"insertText": {"location": {"index": 1}, "text": body_text}})
        if score_table:
            requests.append({
                "insertTable": {
                    "rows": len(score_table),
                    "columns": len(SCORE_TABLE_HEADERS),
                    "location": {"index": len(body_text) + 1},
                }
            })
        self.docs.documents().batchUpdate(
            documentId=file_id, body={"requests": requests}
        ).execute()

        if not score_table:
            return

        # Cell indexes are assigned by Google Docs, so read them after creating the table.
        updated = self.docs.documents().get(documentId=file_id).execute()
        tables = [item for item in updated.get("body", {}).get("content", []) if "table" in item]
        if not tables:
            raise RuntimeError("第3部のGoogle Docs表を作成できませんでした。")
        table = tables[-1]
        cells = _table_cells(table)
        if len(cells) != len(score_table) or any(
            len(row) != len(SCORE_TABLE_HEADERS) for row in cells
        ):
            raise RuntimeError("第3部のGoogle Docs表の行列数が一致しません。")

        table_requests = []
        # Work backwards so text inserted into a cell never invalidates an earlier index.
        for row_index in range(len(score_table) - 1, -1, -1):
            for column_index in range(len(SCORE_TABLE_HEADERS) - 1, -1, -1):
                cell = cells[row_index][column_index]
                cell_content = cell.get("content", [])
                if not cell_content:
                    raise RuntimeError("第3部のGoogle Docs表セル位置を取得できませんでした。")
                table_requests.append({
                    "insertText": {
                        "location": {"index": cell_content[0]["startIndex"]},
                        "text": score_table[row_index][column_index],
                    }
                })
        # Populate first. A later formatting error must never roll back cell text.
        self.docs.documents().batchUpdate(
            documentId=file_id, body={"requests": table_requests}
        ).execute()

        populated = self.docs.documents().get(documentId=file_id).execute()
        populated_tables = [
            item for item in populated.get("body", {}).get("content", []) if "table" in item
        ]
        if not populated_tables or _table_text_rows(populated_tables[-1]) != score_table:
            raise RuntimeError("第3部のGoogle Docs表へ全データを入力できませんでした。")

        # Apply presentation only after content has been verified.
        table_start_index = populated_tables[-1]["startIndex"]
        style_requests = [{
            "updateTableCellStyle": {
                "tableRange": {
                    "tableCellLocation": {
                        "tableStartLocation": {"index": table_start_index},
                        "rowIndex": 0,
                        "columnIndex": 0,
                    },
                    "rowSpan": 1,
                    "columnSpan": len(SCORE_TABLE_HEADERS),
                },
                "tableCellStyle": {
                    "backgroundColor": {
                        "color": {"rgbColor": {"red": 0.9, "green": 0.92, "blue": 0.94}}
                    }
                },
                "fields": "backgroundColor",
            }
        }, {
            "pinTableHeaderRows": {
                "tableStartLocation": {"index": table_start_index},
                "pinnedHeaderRowsCount": 1,
            }
        }]
        self.docs.documents().batchUpdate(
            documentId=file_id, body={"requests": style_requests}
        ).execute()

    def get_file(self, file_id: str) -> dict[str, Any]:
        return self.drive.files().get(
            fileId=file_id, fields="id,name,mimeType,webViewLink,modifiedTime"
        ).execute()

    def send_email(
        self, to: str, subject: str, body: str, deterministic_message_id: str | None = None
    ) -> dict[str, Any]:
        message = EmailMessage()
        message["To"] = to
        message["Subject"] = subject
        if deterministic_message_id:
            message["Message-ID"] = f"<{deterministic_message_id}@pubmed-automation.local>"
        message.set_content(body)
        raw = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")
        return self.gmail.users().messages().send(userId="me", body={"raw": raw}).execute()


def guessed_mime_type(filename: str) -> str:
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"
