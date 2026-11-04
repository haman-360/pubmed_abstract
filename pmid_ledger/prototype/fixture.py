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


if __name__ == "__main__":
    import sys
    print(json.dumps(fixture("--revised" in sys.argv), ensure_ascii=False))
