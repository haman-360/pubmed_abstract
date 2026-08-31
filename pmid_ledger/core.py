"""Deterministic, offline metadata migration and immutable delivery snapshots."""
from __future__ import annotations

import base64
import hashlib
import json
import re
from datetime import datetime
from zoneinfo import ZoneInfo

SCHEMA = "PMID_LEDGER_V1"
HEADERS = {
    "Papers": ["pmid", "title", "journal", "publication_date", "pubmed_url", "doi", "topics", "first_seen", "last_seen", "sources"],
    "Appearances": ["snapshot_id", "pmid", "issue_id", "topic", "delivered_date", "title_at_delivery", "selection", "current_doc_url", "source", "text_id"],
    "Texts": ["text_id", "part", "body"],
    # Only GAS appends Reviews; Python synchronization MUST NOT write this sheet.
    "Reviews": ["operation_id", "pmid", "version", "status", "status_updated_at", "note", "updated_at", "request_hash"],
    "Settings": ["key", "value"],
    "IssueReviews": ["operation_id", "issue_key", "version", "status", "content_version", "updated_at", "request_hash"],
    "Issues": ["issue_key", "issue_id", "topic", "delivered_date", "pmids", "content_version"],
    "TextRows": ["text_id", "first_row", "row_count"],
}
STATUSES = {"unreviewed", "reviewed_no_fulltext", "want_fulltext", "fulltext_obtained", "read"}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def pmid(value):
    value = str(value)
    if not re.fullmatch(r"[1-9][0-9]{0,8}", value):
        raise ValueError("Invalid PMID: " + value[:30])
    return value


def day(value):
    """Only evidenced full dates; never turn YYYY-MM into a fabricated day."""
    if not value:
        return ""
    try:
        text = str(value)
        if len(text) == 10:
            return datetime.strptime(text, "%Y-%m-%d").date().isoformat()
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            return ""
        return stamp.astimezone(ZoneInfo("Asia/Tokyo")).date().isoformat()
    except ValueError:
        return ""


class Dataset:
    def __init__(self, topic_aliases=None):
        self.topic_aliases = topic_aliases or {}
        self.papers = {}
        self.appearances = {}
        self.warnings = []
        self.source_counts = {}

    def paper(self, identifier, source, topic="", seen="", **metadata):
        topic = self.topic_aliases.get(topic, topic)
        identifier = pmid(identifier)
        p = self.papers.setdefault(identifier, {
            "pmid": identifier, "title": "", "journal": "", "publication_date": "", "doi": "",
            "pubmed_url": "https://pubmed.ncbi.nlm.nih.gov/" + identifier + "/",
            "topics": [], "first_seen": "", "last_seen": "", "sources": [],
        })
        for key in ("title", "journal", "publication_date", "doi"):
            if metadata.get(key) and not p[key]:
                p[key] = str(metadata[key])
        for key, value in (("topics", topic), ("sources", source)):
            if value and value not in p[key]:
                p[key].append(value)
                p[key].sort()
        if day(seen):
            p["first_seen"] = min(filter(None, [p["first_seen"], day(seen)]))
            p["last_seen"] = max(p["last_seen"], day(seen))
        return p

    def snapshot(self, identifier, issue, topic, source, delivered="", title="", selection="unknown", doc="", **text):
        topic = self.topic_aliases.get(topic, topic)
        identifier = pmid(identifier)
        self.paper(identifier, source, topic, title=title)
        body = {k: str(v) for k, v in text.items() if v is not None and str(v)}
        value = dict(pmid=identifier, issue_id=issue, topic=topic, delivered_date=day(delivered),
                     title_at_delivery=title, selection=selection, current_doc_url=doc, source=source, text=body)
        key = digest([issue, topic, identifier])
        prior = self.appearances.get(key)
        if prior and prior != value:
            # Preserve differing source revisions rather than silently replace historical text.
            self.warnings.append("snapshot revision preserved: " + issue + ":" + identifier)
            key += ":" + digest(value)[:16]
        self.appearances[key] = value

    def run(self, manifest, articles, scores, final, source):
        if manifest.get("test"):
            return
        doc = manifest.get("components", {}).get("current_doc", {})
        topic = manifest.get("display_name") or manifest.get("topic", "")
        selected = {str(x["pmid"]): x for x in final.get("selected", [])}
        alternates = {str(x["pmid"]): x for x in final.get("alternates", [])}
        score_map = {str(x["pmid"]): x for x in scores}
        # Old manifests did not persist document completion time. Leave date unknown.
        delivered = doc.get("completed_at", "")
        for article in articles:
            identifier = pmid(article["pmid"])
            self.paper(identifier, source, topic, title=article.get("title", ""), journal=article.get("journal", ""),
                       publication_date=article.get("publication_date") or "/".join(str(article.get(x) or "") for x in ("year", "month")).rstrip("/"), doi=article.get("doi", ""))
            if doc.get("state") != "COMPLETED":
                continue
            s = score_map.get(identifier, {})
            chosen = selected.get(identifier, {})
            summary = "\n\n".join(label + "\n" + chosen[key] for key, label in [
                ("why_important", "なぜ重要か"), ("clinical_impact", "臨床への影響"),
                ("practice_change_needed", "診療変更の必要性")] if chosen.get(key))
            self.snapshot(identifier, manifest["run_id"], topic, source, delivered, article.get("title", ""),
                          "selected" if chosen else "alternate_candidate" if identifier in alternates else "candidate",
                          doc.get("url") or ("https://docs.google.com/document/d/" + doc["file_id"] + "/edit" if doc.get("file_id") else ""),
                          summary_ja=summary, one_line_assessment=s.get("one_line_assessment", ""),
                          why_important=chosen.get("why_important", ""), importance=s.get("total_score", ""),
                          outpatient_usefulness=s.get("outpatient_usefulness", ""))

    def payload(self):
        return {"schema": SCHEMA, "papers": sorted(self.papers.values(), key=lambda p: int(p["pmid"])),
                "appearances": [dict(snapshot_id=k, **v) for k, v in sorted(self.appearances.items())]}

    def report(self):
        papers = list(self.papers.values())
        appearances = list(self.appearances.values())
        return {"papers": len(papers), "appearances": len(appearances),
                "with_title": sum(bool(p["title"]) for p in papers),
                "with_summary": sum(bool(a["text"].get("summary_ja")) for a in appearances),
                "with_assessment": sum(bool(a["text"].get("one_line_assessment")) for a in appearances),
                "with_delivery_date": sum(bool(a["delivered_date"]) for a in appearances),
                "warnings": self.warnings, "sources": self.source_counts, "ai_api_calls": 0}


def merge_payload(existing, incoming):
    result = Dataset()
    for payload in (existing, incoming):
        if payload.get("schema") != SCHEMA:
            raise ValueError("Schema mismatch")
        for p in payload["papers"]:
            for source in p["sources"] or [""]:
                result.paper(p["pmid"], source, seen=p.get("first_seen"), **{k: p.get(k, "") for k in ("title", "journal", "publication_date", "doi")})
            result.paper(p["pmid"], "", seen=p.get("last_seen"))
            for topic in p["topics"]:
                result.paper(p["pmid"], "", topic)
        for a in payload["appearances"]:
            value = dict(a)
            key = value.pop("snapshot_id")
            prior = result.appearances.get(key)
            if prior and prior != value:
                # Enrichment never destroys the original historical snapshot.
                key += ":" + digest(value)[:16]
            result.appearances[key] = value
    return result.payload()


def to_tables(payload):
    tables = {name: [headers] for name, headers in HEADERS.items() if name in ("Papers", "Appearances", "Texts", "Issues", "TextRows")}
    texts = {}
    for p in payload["papers"]:
        pmid(p["pmid"])
        tables["Papers"].append([canonical(p[h]) if h in ("topics", "sources") else p.get(h, "") for h in HEADERS["Papers"]])
    for a in payload["appearances"]:
        text = canonical(a["text"])
        text_id = digest(a["text"])
        texts[text_id] = text
        tables["Appearances"].append([text_id if h == "text_id" else a.get(h, "") for h in HEADERS["Appearances"]])
    for key, text in sorted(texts.items()):
        tables["TextRows"].append([key, str(len(tables["Texts"])+1), str((len(text)+19999)//20000)])
        # 20k Unicode codepoints <=40k UTF-16 units, below Sheets' 50k cell limit.
        for i in range(0, len(text), 20000):
            tables["Texts"].append([key, str(i // 20000), text[i:i + 20000]])
    issues = {}
    for a in payload["appearances"]:
        key = canonical([a["issue_id"], a["topic"]])
        g = issues.setdefault(key, {"issue_id":a["issue_id"], "topic":a["topic"], "dates":[], "pmids":set(), "snapshots":set()})
        if a["delivered_date"]:
            g["dates"].append(a["delivered_date"])
        g["pmids"].add(a["pmid"])
        g["snapshots"].add(a["snapshot_id"])
    for key, g in sorted(issues.items()):
        content = base64.urlsafe_b64encode(hashlib.sha256(canonical(sorted(g["snapshots"])).encode()).digest()).decode()
        tables["Issues"].append([key,g["issue_id"],g["topic"],max(g["dates"],default=""),canonical(sorted(g["pmids"],key=int)),content])
    for rows in tables.values():
        for row in rows:
            if any(len(str(v).encode("utf-16-le")) // 2 > 49000 for v in row):
                raise ValueError("Oversize metadata cell; no data written")
    return tables


def from_tables(tables):
    records = {}
    for name in ("Papers", "Appearances", "Texts"):
        rows = tables[name]
        if not rows or rows[0] != HEADERS[name]:
            raise ValueError("Unexpected columns: " + name)
        records[name] = [dict(zip(HEADERS[name], row + [""] * (len(HEADERS[name]) - len(row)))) for row in rows[1:] if row and row[0]]
    chunks = {}
    for t in records["Texts"]:
        chunks.setdefault(t["text_id"], []).append((int(t["part"]), t["body"]))
    for a in records["Appearances"]:
        text_id = a.pop("text_id")
        parts = sorted(chunks[text_id])
        if [i for i, _ in parts] != list(range(len(parts))):
            raise ValueError("Missing text chunk")
        a["text"] = json.loads("".join(s for _, s in parts))
        if digest(a["text"]) != text_id:
            raise ValueError("Snapshot checksum mismatch")
    for p in records["Papers"]:
        p["topics"] = json.loads(p["topics"])
        p["sources"] = json.loads(p["sources"])
    if len({p["pmid"] for p in records["Papers"]}) != len(records["Papers"]):
        raise ValueError("Duplicate PMID")
    return {"schema": SCHEMA, "papers": records["Papers"], "appearances": records["Appearances"]}
