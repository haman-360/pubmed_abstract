import test from "node:test";
import assert from "node:assert/strict";
import { environment } from "./environment.mjs";
function change(e, status = "completed", n = "0001") {
  const i = e.ctx
    .listIssues({ status: "all" })
    .items.find((i) => i.issue_id === "issue1");
  return {
    operation_id: "issue-operation-" + n,
    issue_key: i.issue_key,
    status,
    expected_version: i.version,
    content_version: i.content_version,
  };
}
function classify(e) {
  e.ctx.saveReviews({
    operation_id: "paper-operation-0001",
    changes: [
      {
        pmid: "1",
        status: "want_fulltext",
        note: "keep this note",
        expected_version: 0,
      },
    ],
  });
}
test("separate topic/issue completion; CURRENT reuse and PMID decisions do not imply reading a delivery", () => {
  const e = environment();
  const i = e.ctx.listIssues({}).items;
  assert.equal(i.length, 2);
  assert.equal(i[0].status, "unreviewed");
  assert.throws(() => e.ctx.saveIssueReview(change(e)), /未確認/);
  classify(e);
  assert.equal(e.ctx.listIssues({}).items[0].status, "unreviewed");
  const before = JSON.stringify(e.tables.Reviews);
  e.ctx.saveIssueReview(change(e));
  assert.equal(JSON.stringify(e.tables.Reviews), before);
  assert.equal(e.ctx.listIssues({ status: "completed" }).items.length, 1);
  assert.equal(e.ctx.listIssues({}).items[0].issue_id, "issue2");
  // Next delivery can reuse BOTH PMID and CURRENT document without inheriting completion.
  e.tables.Appearances.push([
    "s3",
    "1",
    "next-week",
    "感染症",
    "2026-08-29",
    "title",
    "candidate",
    "https://docs.google.com/document/d/current/edit",
    "test",
    "t2",
  ]);
  assert.equal(
    e.ctx.listIssues({}).items.find((i) => i.issue_id === "next-week").status,
    "unreviewed",
  );
});
test("issue filters restrict both papers and detailed historical summaries", () => {
  const e = environment(),
    key = JSON.stringify(["issue2", "腎臓"]);
  assert.deepEqual(
    e.plain(
      e.ctx.listPapers({ tab: "all", issue_key: key }).items.map((p) => p.pmid),
    ),
    ["1"],
  );
  const detail = e.ctx.getPaperDetail({ pmid: "1", issue_key: key });
  assert.equal(detail.appearances.length, 1);
  assert.equal(detail.appearances[0].text.one_line_assessment, "一行評価");
  assert.equal(
    e.ctx.listIssues({ from: "2026-08-01", status: "all" }).items.length,
    1,
  );
  assert.throws(
    () => e.ctx.listIssues({ from: "2026-08-30", to: "2026-01-01" }),
    /逆/,
  );
});
test("issue save retries, conflicts, failures and content additions are safe", () => {
  const e = environment();
  classify(e);
  const r = change(e);
  e.ctx.saveIssueReview(r);
  e.ctx.saveIssueReview(r);
  assert.equal(e.tables.IssueReviews.length, 2);
  assert.throws(
    () => e.ctx.saveIssueReview({ ...r, operation_id: "issue-operation-0002" }),
    /更新/,
  );
  assert.throws(
    () => e.ctx.saveIssueReview({ ...r, status: "unreviewed" }),
    /再利用/,
  );
  e.tables.Appearances.push([
    "s-extra",
    "1",
    "issue1",
    "感染症",
    "2026-08-20",
    "revision",
    "candidate",
    "",
    "test",
    "t2",
  ]);
  const i = e.ctx.listIssues({}).items.find((i) => i.issue_id === "issue1");
  assert.equal(i.status, "in_progress");
  assert.equal(i.content_changed, true);
  assert.equal(e.tables.IssueReviews[1][3], "completed");
  for (const opts of [
    { failWrite: true },
    { failFlush: true },
    { stranger: true },
    { locked: true },
  ]) {
    const f = environment(opts);
    assert.throws(() =>
      f.ctx.saveIssueReview({
        operation_id: "issue-operation-fail",
        issue_key: JSON.stringify(["issue1", "感染症"]),
        status: "in_progress",
        expected_version: 0,
        content_version: f.ctx.hashIssue_(["s1"]),
      }),
    );
  }
  const f = environment();
  assert.throws(
    () =>
      f.ctx.saveIssueReview({
        ...change(f, "in_progress"),
        simulate_failure: true,
      }),
    /TEST/,
  );
  assert.equal(f.tables.IssueReviews.length, 1);
});
test("older ledger missing IssueReviews upgrades on explicit first save and backup keeps both event logs", () => {
  const e = environment();
  delete e.tables.IssueReviews;
  assert.equal(e.ctx.listIssues({}).items.length, 2);
  const r = change(e, "in_progress");
  e.ctx.saveIssueReview(r);
  assert.equal(e.tables.IssueReviews.length, 2);
  const backup = JSON.parse(e.ctx.exportData({ format: "backup" }).text);
  assert.equal(backup.tables.IssueReviews.length, 2);
  assert.equal(backup.tables.Reviews.length, 1);
});
