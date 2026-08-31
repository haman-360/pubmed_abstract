"""Google-only transport. Existing drive.file OAuth, no AI/PubMed/Gmail clients."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from .core import HEADERS, SCHEMA, STATUSES, canonical, digest, from_tables, merge_payload, to_tables, pmid


class GoogleStore:
    def __init__(self, auth_path="google_authorized_user.json"):
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        raw = os.environ.get("GOOGLE_AUTHORIZED_USER_JSON") or Path(auth_path).read_text()
        creds = Credentials.from_authorized_user_info(json.loads(raw), scopes=["https://www.googleapis.com/auth/drive.file"])
        self.drive = build("drive", "v3", credentials=creds, cache_discovery=False)
        self.sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)
        self.cache = {}

    def children(self, parent):
        result = []
        token = None
        while True:
            page = self.drive.files().list(q=f"'{parent}' in parents and trashed = false", pageSize=1000,
                pageToken=token, fields="nextPageToken,files(id,name,mimeType,modifiedTime)").execute(num_retries=3)
            result.extend(page.get("files", []))
            token = page.get("nextPageToken")
            if not token:
                return result

    def child(self, parent, name):
        matches = [x for x in self.children(parent) if x["name"] == name]
        if len(matches) != 1:
            raise ValueError(f"Expected one existing child {name}, found {len(matches)}")
        return matches[0]

    def named(self, name):
        escaped = name.replace("\\", "\\\\").replace("'", "\\'")
        result, token = [], None
        while True:
            page = self.drive.files().list(q=f"name = '{escaped}' and trashed = false", pageSize=1000,
                pageToken=token, fields="nextPageToken,files(id,name,parents)").execute(num_retries=3)
            result.extend(page.get("files", []))
            token = page.get("nextPageToken")
            if not token:
                return result

    def json(self, file_id):
        if file_id not in self.cache:
            self.cache[file_id] = json.loads(self.drive.files().get_media(fileId=file_id).execute(num_retries=3).decode("utf-8-sig"))
        return self.cache[file_id]

    def export_doc(self, file_id):
        return self.drive.files().export(fileId=file_id, mimeType="text/plain").execute(num_retries=3).decode("utf-8-sig")

    def identity(self):
        return self.drive.about().get(fields="user(emailAddress)").execute()["user"]["emailAddress"]

    def verify(self, sheet_id, instance):
        meta = self.drive.files().get(fileId=sheet_id,
            fields="id,name,mimeType,appProperties,owners(emailAddress),permissions(type,role,emailAddress),parents").execute(num_retries=3)
        if meta["mimeType"] != "application/vnd.google-apps.spreadsheet" or meta.get("appProperties", {}).get("pmidLedgerInstance") != instance:
            raise ValueError("Not the designated ledger spreadsheet")
        if any(p["role"] != "owner" for p in meta.get("permissions", [])):
            raise ValueError("Ledger must be owner-only")
        return meta

    def create(self, parent, title, instance):
        matches = [x for x in self.children(parent) if x["name"] == title]
        if len(matches) > 1:
            raise ValueError("Duplicate ledger names; resolve explicitly")
        if matches:
            sheet_id = matches[0]["id"]
            self.verify(sheet_id, instance)
        else:
            sheet_id = self.drive.files().create(body={"name": title, "mimeType": "application/vnd.google-apps.spreadsheet",
                "parents": [parent], "appProperties": {"pmidLedgerInstance": instance}}, fields="id").execute()["id"]
        spreadsheet = self.sheets.spreadsheets().get(spreadsheetId=sheet_id, fields="sheets.properties").execute()
        existing = {s["properties"]["title"]: s["properties"] for s in spreadsheet.get("sheets", [])}
        if "Settings" in existing:
            self.read(sheet_id, instance)
            return sheet_id
        if set(existing) & set(HEADERS):
            raise ValueError("Partial schema; do not overwrite it")
        requests = [{"updateSpreadsheetProperties": {"properties": {"timeZone": "Asia/Tokyo"}, "fields": "timeZone"}}]
        for i, (name, headers) in enumerate(HEADERS.items(), 101):
            requests.append({"addSheet": {"properties": {"sheetId": i, "title": name, "gridProperties": {"rowCount": 1000, "columnCount": max(10, len(headers)), "frozenRowCount": 1}}}})
            rows = [headers]
            if name == "Settings":
                rows += [["schema", SCHEMA], ["instance", instance], ["revision", ""], ["synced_at", ""]]
            requests.append(self.cells(i, rows))
        self.sheets.spreadsheets().batchUpdate(spreadsheetId=sheet_id, body={"requests": requests}).execute()
        self.verify(sheet_id, instance)
        return sheet_id

    @staticmethod
    def cells(sheet_id, rows):
        # Typed stringValue prevents formulas, date coercion, and PMID precision loss.
        return {"updateCells": {"start": {"sheetId": sheet_id, "rowIndex": 0, "columnIndex": 0},
            "rows": [{"values": [{"userEnteredValue": {"stringValue": str(v)}} for v in row]} for row in rows],
            "fields": "userEnteredValue"}}

    def read(self, sheet_id, instance):
        self.verify(sheet_id, instance)
        metadata = self.sheets.spreadsheets().get(spreadsheetId=sheet_id, fields="sheets.properties.title").execute(num_retries=3)
        available = {s["properties"]["title"] for s in metadata["sheets"]}
        names = [n for n in HEADERS if n not in ("IssueReviews", "Issues", "TextRows") or n in available]
        response = self.sheets.spreadsheets().values().batchGet(spreadsheetId=sheet_id,
            ranges=names, valueRenderOption="UNFORMATTED_VALUE").execute(num_retries=3)
        tables = {name: part.get("values", []) for name, part in zip(names, response["valueRanges"])}
        # Older ledgers/backups remain readable; only GAS creates the optional event sheet.
        for name in ("IssueReviews", "Issues", "TextRows"):
            tables.setdefault(name, [HEADERS[name]])
        for name, headers in HEADERS.items():
            if not tables[name] or tables[name][0] != headers:
                raise ValueError("Unexpected schema: " + name)
        settings = {r[0]: r[1] if len(r) > 1 else "" for r in tables["Settings"][1:]}
        if settings.get("schema") != SCHEMA or settings.get("instance") != instance:
            raise ValueError("Wrong ledger environment")
        return tables

    def publish(self, sheet_id, instance, incoming, backup_dir):
        current = self.read(sheet_id, instance)
        existing = from_tables(current)
        merged = merge_payload(existing, incoming)
        tables = to_tables(merged)
        if digest(existing) == digest(merged) and all(current.get(n) == tables[n] for n in ("Issues", "TextRows")):
            return {"changed": False, "papers": len(merged["papers"]), "appearances": len(merged["appearances"])}
        if existing["papers"] and not instance.startswith("test-") and os.environ.get("GITHUB_ACTIONS") != "true" and os.environ.get("PMID_LEDGER_MAINTENANCE") != "1":
            raise ValueError("Production metadata has one writer: use the GitHub sync workflow. For local maintenance, disable that workflow first and set PMID_LEDGER_MAINTENANCE=1.")
        now = datetime.now(timezone.utc).isoformat()
        backup_path = Path(backup_dir) / ("before-" + now.replace(":", "-") + ".json")
        backup_path.parent.mkdir(parents=True, exist_ok=True)
        backup_path.write_text(canonical({"schema": SCHEMA, "instance": instance, "tables": current}), encoding="utf-8")
        backup_path.chmod(0o600)
        # Server-side full copy also preserves review events created after our read.
        metadata = self.verify(sheet_id, instance)
        backup = self.drive.files().copy(fileId=sheet_id, body={"name": "PMID台帳_BACKUP_" + now,
            "parents": metadata.get("parents", []), "appProperties": {"pmidLedgerInstance": instance + ":backup"}}, fields="id").execute()
        props = self.sheets.spreadsheets().get(spreadsheetId=sheet_id, fields="sheets.properties").execute()
        by_name = {s["properties"]["title"]: s["properties"] for s in props["sheets"]}
        requests = []
        next_id = max(p["sheetId"] for p in by_name.values()) + 1
        for name, rows in tables.items():
            if name not in by_name:
                if name not in ("Issues", "TextRows"):
                    raise ValueError("Missing core sheet; refusing rebuild")
                by_name[name] = {"sheetId":next_id, "gridProperties":{"rowCount":max(1000,len(rows))}}
                requests.append({"addSheet":{"properties":{"sheetId":next_id,"title":name,"gridProperties":{"rowCount":max(1000,len(rows)),"columnCount":max(10,len(HEADERS[name])),"frozenRowCount":1}}}})
                next_id += 1
            p = by_name[name]
            needed = max(len(rows), p["gridProperties"]["rowCount"])
            requests.append({"updateSheetProperties": {"properties": {"sheetId": p["sheetId"], "gridProperties": {"rowCount": needed}}, "fields": "gridProperties.rowCount"}})
            requests.append({"updateCells": {"range": {"sheetId": p["sheetId"]}, "fields": "userEnteredValue"}})
            requests.append(self.cells(p["sheetId"], rows))
        requests.append(self.cells(by_name["Settings"]["sheetId"], [HEADERS["Settings"], ["schema", SCHEMA], ["instance", instance], ["revision", digest(merged)], ["synced_at", now]]))
        # One atomic transaction. No requests ever target Reviews.
        body = {"requests": requests}
        if len(canonical(body).encode()) > 18000000:
            raise ValueError("Metadata exceeds 18MB atomic sync safety limit; use a larger storage design")
        self.sheets.spreadsheets().batchUpdate(spreadsheetId=sheet_id, body=body).execute()
        verified_tables = self.read(sheet_id, instance)
        verified = from_tables(verified_tables)
        if digest(verified) != digest(merged) or any(verified_tables[n] != tables[n] for n in ("Issues", "TextRows")):
            raise ValueError("Published metadata verification failed; review state was not written")
        return {"changed": True, "papers": len(merged["papers"]), "appearances": len(merged["appearances"]), "backup_file_id": backup["id"]}

    def restore_copy(self, backup, parent, title, instance):
        """Restore to a NEW empty instance only. Never overwrite a live review ledger."""
        if backup.get("schema") != SCHEMA or instance == backup.get("instance"):
            raise ValueError("Restore requires a new instance identifier")
        tables = backup["tables"]
        payload = from_tables(tables)
        ids = {p["pmid"] for p in payload["papers"]}
        if tables["Reviews"][0] != HEADERS["Reviews"]:
            raise ValueError("Invalid review schema")
        versions = {}
        for row in tables["Reviews"][1:]:
            row = list(row) + [""] * (8-len(row))
            identifier = pmid(row[1])
            version = int(row[2])
            if identifier not in ids or row[3] not in STATUSES or version != versions.get(identifier, 0)+1:
                raise ValueError("Invalid review event sequence")
            versions[identifier] = version
        issue_rows = tables.get("IssueReviews", [HEADERS["IssueReviews"]])
        if not issue_rows or issue_rows[0] != HEADERS["IssueReviews"]:
            raise ValueError("Invalid issue review schema")
        issue_keys = {canonical([a["issue_id"], a["topic"]]) for a in payload["appearances"]}
        issue_versions = {}
        for row in issue_rows[1:]:
            if len(row) != 7 or row[1] not in issue_keys or row[3] not in ("unreviewed", "in_progress", "completed") or int(row[2]) != issue_versions.get(row[1], 0)+1:
                raise ValueError("Invalid issue review event sequence")
            issue_versions[row[1]] = int(row[2])
        sheet_id = self.create(parent, title, instance)
        current = self.read(sheet_id, instance)
        if any(len(current[n]) != 1 for n in ("Papers","Appearances","Texts","Reviews","IssueReviews")):
            raise ValueError("Restore target is not empty; no writes performed")
        metadata = self.sheets.spreadsheets().get(spreadsheetId=sheet_id, fields="sheets.properties").execute()
        by_name = {s["properties"]["title"]: s["properties"] for s in metadata["sheets"]}
        restore = dict(to_tables(payload), Reviews=tables["Reviews"], IssueReviews=issue_rows, Settings=[HEADERS["Settings"],
            ["schema",SCHEMA],["instance",instance],["revision",digest(payload)],
            ["synced_at",datetime.now(timezone.utc).isoformat()]])
        requests = []
        for name, rows in restore.items():
            p = by_name[name]
            requests.append({"updateSheetProperties":{"properties":{"sheetId":p["sheetId"],"gridProperties":{"rowCount":max(1000,len(rows))}},"fields":"gridProperties.rowCount"}})
            requests.append(self.cells(p["sheetId"], rows))
        self.sheets.spreadsheets().batchUpdate(spreadsheetId=sheet_id, body={"requests":requests}).execute()
        verified = self.read(sheet_id,instance)
        if digest(from_tables(verified)) != digest(payload):
            raise ValueError("Restore verification failed")
        def padded(rows):
            return [list(r)+[""]*(8-len(r)) for r in rows]
        if padded(verified["Reviews"]) != padded(tables["Reviews"]) or verified["IssueReviews"] != issue_rows:
            raise ValueError("Review restore verification failed")
        return sheet_id
