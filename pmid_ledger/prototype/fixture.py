"""Synthetic only; no config, credentials, network, or existing artifacts are read."""
import json
from pmid_ledger.core import Dataset, to_tables, digest


def fixture(revised=False):
    data = Dataset()
    titles = ["架空 Clinical Study", "100%_Exact 'quote'", "架空の日本語🧪", "İstanbul CASE"]
    for number in range(1, 121):
        data.paper(str(number), "synthetic", "感染症", seen="2026-08-20",
                   title=titles[(number - 1) % len(titles)] + f" {number}")
    groups = [("synthetic-main", "感染症", range(1, 101), "2026-08-20"),
              ("synthetic-main", "腎臓", range(1, 11), "2026-01-10"),
              ("synthetic-legacy", "感染症", range(101, 121), ""),
              ("synthetic-small", "感染症", range(1, 2), "2026-08-20"),
              ("synthetic-old", "腎臓", range(11, 16), "2026-01-10"),
              ("synthetic-other", "感染症", range(116, 121), "2026-08-20")]
    for issue, topic, members, date in groups:
        rows = []
        for position, number in enumerate(members):
            title = data.papers[str(number)]["title"]
            snapshot = data.snapshot(str(number), issue, topic, "synthetic", date, title,
                                     "candidate", "", summary_ja="架空本文🧪" * (5000 if number == 1 else 2))
            rows.append(dict(pmid=str(number), snapshot_id=snapshot, position=position,
                             title=title, total_score=str(position % 30),
                             usefulness="未評価", ai_memo="架空の評価"))
        if issue != "synthetic-legacy":
            data.issue_candidates[json.dumps([issue, topic], ensure_ascii=False, separators=(",", ":"))] = rows
    if revised:
        data.snapshot("1", "synthetic-small", "感染症", "synthetic", "2026-08-20",
                      "訂正版の架空タイトル", "candidate", "", summary_ja="訂正版の架空本文")
    payload = data.payload()
    return dict(synthetic=True, generation=digest(payload), tables=to_tables(payload))


def scale_fixture(papers=5000, issues=200, browse_dates=False):
    """Two appearances per PMID, with unique synthetic summaries and candidate rows."""
    if not (1 <= papers <= 5000 and 1 <= issues <= 200 and 2 * papers % issues == 0):
        raise ValueError("Invalid synthetic scale")
    data = Dataset()
    for n in range(1, papers + 1):
        data.paper(str(n), "synthetic-scale", "感染症", seen="2026-08-20",
                   title=f"架空 Scale Clinical Study {n}: 日本語・100%_評価🧪")
    for i in range(issues):
        issue = f"synthetic-scale-{i:03d}"
        date = ("2026-10-20" if i < 10 else "2026-09-20" if i < 20 else "2025-01-10") if browse_dates else "2026-08-20"
        rows = []
        for position in range(2 * papers // issues):
            identifier = str((i * (2 * papers // issues) + position) % papers + 1)
            title = data.papers[identifier]["title"]
            snapshot = data.snapshot(identifier, issue, "感染症", "synthetic-scale", date,
                                     title, "candidate", "", summary_ja=f"架空論文{identifier}：" + "架空の本文。" * 100)
            rows.append(dict(pmid=identifier, snapshot_id=snapshot, position=position, title=title,
                             total_score=str(position % 30), usefulness="未評価", ai_memo="架空の評価"))
        data.issue_candidates[json.dumps([issue, "感染症"], ensure_ascii=False, separators=(",", ":"))] = rows
    payload = data.payload()
    return dict(synthetic=True, generation=digest(payload), tables=to_tables(payload))


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--revised", action="store_true")
    parser.add_argument("--scale", action="store_true")
    parser.add_argument("--papers", type=int, default=5000)
    parser.add_argument("--issues", type=int, default=200)
    parser.add_argument("--browse", action="store_true", help="Synthetic mixed dates for recent/archive tests")
    args = parser.parse_args()
    value = scale_fixture(args.papers, args.issues, args.browse) if args.scale else fixture(args.revised)
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
