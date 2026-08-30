"""Read existing artifacts only. Never execute pipeline, prompts, or AI clients."""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from pathlib import Path
from .core import Dataset, day, digest

EXPLICIT = re.compile(r"(?:PMID\s*\*{0,2}\s*[:：]?\s*\*{0,2}\s*|pubmed\.ncbi\.nlm\.nih\.gov/)([1-9][0-9]{0,8})(?!\d)", re.I)
TABLE = re.compile(r"^\s*\|?\s*([1-9][0-9]{0,8})\s*\|\s*(.+)$", re.M)


class PlainHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        if tag in ("p", "br", "div", "h1", "h2", "h3", "tr", "li"):
            self.parts.append("\n")
        if tag in ("td", "th"):
            self.parts.append(" | ")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        if tag in ("p", "div", "h1", "h2", "h3", "tr"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def parse_text(data, text, source, issue, topic="", seen="", doc=""):
    """Extract only explicit PMID sections; preserve uncertain prose with provenance."""
    if "<html" in text.lower() or "<body" in text.lower():
        parser = PlainHTML()
        parser.feed(text)
        text = "".join(parser.parts)
    identifiers = set(EXPLICIT.findall(text)) | {m[0] for m in TABLE.findall(text)}
    for identifier in identifiers:
        data.paper(identifier, source, topic, seen)
    # One-line assessments in the actual candidate table (not arbitrary number lists).
    table_part = re.split(r"第[3３]部[^\n]*|候補論文スコア一覧", text, maxsplit=1)
    candidates = {}
    if len(table_part) > 1:
        for identifier, rest in TABLE.findall(table_part[1]):
            cells = [s.strip() for s in rest.strip().strip("|").split("|")]
            if len(cells) >= 4:
                candidates[identifier] = {"title": cells[0], "importance": cells[1], "one_line_assessment": " | ".join(cells[3:])}
    # Japanese selected sections are bounded by each ① heading and 第2部.
    japanese = re.split(r"第[2２]部", text, maxsplit=1)[0]
    selected = {}
    for block in re.split(r"(?m)(?=^[#\s\d.]*①)", japanese):
        match = re.search(r"②\s*PMID\s*[:：]?\s*([1-9][0-9]{0,8})(?!\d)", block)
        if match and "③" in block:
            identifier = match[1]
            title = re.split(r"②", block, maxsplit=1)[0].strip().lstrip("# .0123456789①").strip()
            title = re.sub(r"^タイトル\s*", "", title)
            summary = block[block.index("③"):].strip().rstrip("-\n ")
            selected[identifier] = {"title": title, "summary_ja": summary}
    for identifier in sorted(candidates.keys() | selected.keys()):
        values = dict(candidates.get(identifier, {}), **selected.get(identifier, {}))
        title = values.pop("title", "")
        data.snapshot(identifier, issue, topic, source, title=title, selection="selected" if identifier in selected else "candidate", doc=doc, **values)
    # Original abstract files have headings followed by explicit PMID lines.
    current_topic = topic
    for block in re.split(r"(?m)(?=^##(?:#)? )", text):
        heading = block.splitlines()[0] if block.splitlines() else ""
        if re.fullmatch(r"## [A-Za-z][A-Za-z_]+", heading):
            current_topic = heading[3:]
        matches = EXPLICIT.findall(block)
        unique = set(matches)
        if len(unique) != 1:
            continue
        identifier = next(iter(unique))
        title_match = re.match(r"^###?\s+(?:\[\d+\]|\d+[.．])\s+(.+)", heading)
        journal = re.search(r"(?:\*\*)?Journal(?:\*\*)?\s*:\s*([^\n]+)", block)
        data.paper(identifier, source, current_topic, seen, title=title_match[1] if title_match else "", journal=journal[1].strip() if journal else "")
    data.source_counts[source] = len(identifiers)


def collect_local(root: Path, data: Dataset):
    paths = set()
    for pattern in ("chatgpt_outputs/**/*abstract10本.*", "archive/processed/**/*abstract10本.*", "abstracts_*.md", "archive/generated_outputs/*.md"):
        paths.update(root.glob(pattern))
    seen_content = set()
    for path in sorted(paths):
        if path.suffix not in (".txt", ".md", ".html"):
            continue
        if path.suffix == ".html" and path.with_suffix(".txt").exists():
            continue
        text = path.read_text(encoding="utf-8-sig")
        content_id = digest(text)
        if content_id in seen_content:
            continue
        seen_content.add(content_id)
        source = str(path.relative_to(root))
        topic_match = re.search(r"\d{4}-\d{2}_(?:w\d_)?(.+?)_abstract", path.stem)
        acquired = re.search(r"取得日時:\s*(\d{4}-\d{2}-\d{2})", text)
        parse_text(data, text, source, "local:" + path.stem, topic_match[1] if topic_match else "", acquired[1] if acquired else "")
    for path in (root / "missed_papers/known_pmids.json", root / "selected_pmids_history.json"):
        if not path.exists():
            continue
        value = json.loads(path.read_text())
        # These two files are explicitly historical sets, never include missed candidate search output.
        ids = value.get("pmids", []) if isinstance(value, dict) else value
        if isinstance(value, dict) and "pmids" not in value:
            ids = [key for key in value if re.fullmatch(r"[1-9][0-9]{0,8}", key)]
        for identifier in ids:
            data.paper(identifier, str(path.relative_to(root)))
        data.source_counts[str(path.relative_to(root))] = len(ids)


def collect_drive(reader, root_id, data: Dataset, include_docs=False, progress=None):
    """No ensure_folder, no uploads: fail if the existing production root is absent."""
    base = reader.child(root_id, "PubMed_Automation")
    system = reader.child(base["id"], "system")
    ledger_ref = reader.child(system["id"], "automation_ledger.json")
    ledger = reader.json(ledger_ref["id"])
    raw_seen = set()
    for name, info in sorted(ledger["topics"].items()):
        if progress:
            progress("PMIDインデックスを読み取り中：" + name)
        if not info.get("pmid_index_file_id"):
            continue
        index = reader.json(info["pmid_index_file_id"])
        source = "drive:" + info["pmid_index_file_id"]
        for identifier, p in index.get("papers", {}).items():
            data.paper(identifier, source, name, p.get("first_seen_at", ""))
            data.paper(identifier, source, name, p.get("last_seen_at", ""))
            raw_id = p.get("raw_file_id")
            if raw_id and raw_id not in raw_seen:
                raw_seen.add(raw_id)
                raw = reader.json(raw_id)
                for a in raw.get("articles", []):
                    data.paper(a["pmid"], "drive:" + raw_id, name, title=a.get("title", ""), journal=a.get("journal", ""),
                               publication_date=a.get("publication_date") or "/".join(str(a.get(x) or "") for x in ("year", "month")).rstrip("/"), doi=a.get("doi", ""))
        data.source_counts[source] = len(index.get("papers", {}))
    manifests = set()
    for cycle in ledger.get("cycles", {}).values():
        for info in cycle.get("topics", {}).values():
            if info.get("run_manifest_file_id"):
                manifests.add(info["run_manifest_file_id"])
    for info in ledger["topics"].values():
        if info.get("last_run_manifest_file_id"):
            manifests.add(info["last_run_manifest_file_id"])
    # Include historical run folders no longer referenced by the lightweight ledger.
    runs = reader.child(base["id"], "runs")
    topic_folders = set()
    for cycle in reader.children(runs["id"]):
        if cycle["mimeType"] != "application/vnd.google-apps.folder":
            continue
        for topic in reader.children(cycle["id"]):
            if topic["mimeType"] == "application/vnd.google-apps.folder":
                topic_folders.add(topic["id"])
    # One name query replaces hundreds of per-run directory listings. Still restrict parents.
    manifests.update(x["id"] for x in reader.named("run_manifest.json") if topic_folders.intersection(x.get("parents", [])))
    for identifier in sorted(manifests):
        m = reader.json(identifier)
        if m.get("test"):
            continue
        artifacts = m.get("artifacts", {})
        raw = reader.json(artifacts["all_abstracts"]["file_id"])
        scores = reader.json(artifacts["screen_evaluations"]["file_id"]) if artifacts.get("screen_evaluations") else []
        final = reader.json(artifacts["final_evaluation"]["file_id"]) if artifacts.get("final_evaluation") else {}
        data.run(m, raw["articles"], scores, final, "drive:" + identifier)
        data.source_counts["drive:" + identifier] = len(raw["articles"])
        if progress:
            progress("配信成果物を復元：" + m.get("run_id", "") + " / PMID累計 " + str(len(data.papers)))
    if include_docs:
        for topic, info in ledger["topics"].items():
            if info.get("current_file_id"):
                identifier = info["current_file_id"]
                text = reader.export_doc(identifier)
                # Stable content identity; CURRENT is a read-time copy, never a dated old issue.
                parse_text(data, text, "current_doc:" + identifier, "current_copy:" + identifier + ":" + digest(text)[:16], topic,
                           doc="https://docs.google.com/document/d/" + identifier + "/edit")
