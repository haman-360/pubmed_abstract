import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { environment } from "./environment.mjs";
const request = (extra = {}) => ({
  operation_id: "operation-test-0001",
  changes: [
    {
      pmid: "1",
      status: "want_fulltext",
      note: "=dangerous formula",
      expected_version: 0,
    },
  ],
  ...extra,
});
test("metadata stays untouched; note formula is literal; exact retries append once", () => {
  const e = environment(),
    before = JSON.stringify([
      e.tables.Papers,
      e.tables.Appearances,
      e.tables.Texts,
    ]);
  e.ctx.saveReviews(request());
  e.ctx.saveReviews(request());
  assert.equal(e.writes(), 1);
  assert.equal(
    JSON.stringify([e.tables.Papers, e.tables.Appearances, e.tables.Texts]),
    before,
  );
  const row = e.ctx.listPapers({ tab: "want" }).items[0];
  assert.equal(row.review.note, "=dangerous formula");
  assert.equal(row.review.status, "want_fulltext");
  assert.throws(
    () => e.ctx.saveReviews(request({ operation_id: "operation-test-0002" })),
    /別の画面/,
  );
});
test("failed save, flush and auth never return success", () => {
  for (const opts of [
    { failWrite: true },
    { failFlush: true },
    { stranger: true },
    { locked: true },
  ]) {
    const e = environment(opts);
    assert.throws(() => e.ctx.saveReviews(request()));
  }
  const e = environment();
  assert.throws(
    () => e.ctx.saveReviews(request({ simulate_failure: true })),
    /TEST/,
  );
  assert.equal(e.writes(), 0);
});
test("bulk validates every version before any append and rejects reused operation content", () => {
  const e = environment();
  assert.throws(
    () =>
      e.ctx.saveReviews(
        request({
          changes: [
            ...request().changes,
            { pmid: "10", status: "read", note: "", expected_version: 9 },
          ],
        }),
      ),
    /別の画面/,
  );
  assert.equal(e.writes(), 0);
  e.ctx.saveReviews(request());
  assert.throws(
    () =>
      e.ctx.saveReviews(
        request({ changes: [{ ...request().changes[0], note: "different" }] }),
      ),
    /操作ID/,
  );
});
test("same appearance date and topic filters; blank dates; numeric sort and old pending", () => {
  const e = environment();
  assert.equal(
    e.ctx.listPapers({ tab: "all", topic: "腎臓", from: "2026-08-01" }).total,
    0,
  );
  assert.equal(
    e.ctx.listPapers({ tab: "all", topic: "感染症", from: "2026-08-01" }).total,
    1,
  );
  assert.deepEqual(
    e.plain(
      e.ctx
        .listPapers({ tab: "all", sort: "pmid_desc" })
        .items.map((p) => p.pmid),
    ),
    ["10", "1"],
  );
  e.ctx.saveReviews(
    request({
      changes: [
        {
          pmid: "10",
          status: "fulltext_obtained",
          note: "old",
          expected_version: 0,
        },
      ],
    }),
  );
  assert.equal(e.ctx.listPapers({ tab: "obtained" }).total, 1);
  assert.equal(e.ctx.listPapers({ tab: "old" }).total, 0);
});
test("TXT only wanted selected IDs, numeric, BOM-free; CSV formula escape", () => {
  const e = environment();
  e.ctx.saveReviews(request());
  assert.equal(e.ctx.exportData({ format: "txt" }).text, "1\n");
  assert.equal(e.ctx.exportData({ format: "txt", ids: ["10"] }).text, "");
  const csv = e.ctx.exportData({ format: "csv", filter: { tab: "all" } }).text;
  assert.match(csv, /'=dangerous formula/);
  assert.equal(
    Buffer.from(e.ctx.exportData({ format: "txt" }).text).toString("hex"),
    "310a",
  );
});
test("separate historical texts and full backup preserve event log", () => {
  const e = environment();
  const d = e.ctx.getPaperDetail("1");
  assert.equal(d.appearances[0].text.summary_ja, "保存済み日本語要約");
  assert.equal(d.appearances[1].text.one_line_assessment, "一行評価");
  e.ctx.saveReviews(request());
  const b = JSON.parse(e.ctx.exportData({ format: "backup" }).text);
  assert.equal(b.tables.Reviews.length, 2);
});
test("5000 papers paginated without returning summary text", () => {
  const e = environment();
  const example = e.tables.Papers[1];
  for (let i = 100; i < 5100; i++)
    e.tables.Papers.push([String(i), ...example.slice(1)]);
  const start = performance.now(),
    r = e.ctx.listPapers({ tab: "all", offset: 100, sort: "pmid_asc" });
  assert.equal(r.items.length, 50);
  assert.equal(r.total, 5002);
  assert.equal(r.items[0].pmid, "198");
  assert.equal(r.items[0].appearances, undefined);
  assert.ok(performance.now() - start < 2000);
});
test("backup rejects metadata changing while tables are read", () => {
  const e = environment({
    onRead(name, tables) {
      if (name === "Texts")
        tables.Settings.find((r) => r[0] === "revision")[1] = "two";
    },
  });
  assert.throws(() => e.ctx.exportData({ format: "backup" }), /同期中/);
});
test("all inline scripts parse and production has no AI/network clients", () => {
  const html = fs.readFileSync(
    new URL("../gas/Index.html", import.meta.url),
    "utf8",
  );
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))
    new vm.Script(match[1]);
  assert.doesNotMatch(html, /fetch\(|XMLHttpRequest|`https?:\/\//);
  const source = fs.readFileSync(
    new URL("../gas/Code.gs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /UrlFetchApp|GmailApp|DriveApp|api\.openai/);
});
