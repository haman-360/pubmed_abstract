import test from "node:test";
import assert from "node:assert/strict";
import { environment } from "./environment.mjs";

test("indexed delivery list never reads papers, appearances or summaries or hashes every issue", () => {
  const reads = [];
  const e = environment({
    indexed: true,
    cache: new Map(),
    onRead: (name) => reads.push(name),
  });
  e.ctx.Utilities.computeDigest = () => {
    throw new Error("unexpected digest");
  };
  assert.equal(e.ctx.listIssues({}).items.length, 2);
  assert.equal(
    reads.some((n) => ["Papers", "Appearances", "Texts"].includes(n)),
    false,
  );
  reads.length = 0;
  e.ctx.listIssues({});
  assert.equal(reads.includes("Issues"), false);
  assert.ok(reads.includes("Reviews") && reads.includes("IssueReviews"));
  assert.equal(e.writes(), 0);
});

test("cached metadata preserves fresh manual states, completion conflicts, and revision invalidation", () => {
  const cache = new Map();
  const e = environment({ indexed: true, cache });
  const first = e.ctx.listIssues({}).items.find((i) => i.issue_id === "issue1");
  assert.equal(first.unreviewed, 1);
  e.ctx.saveReviews({
    operation_id: "paper-operation-index",
    changes: [
      { pmid: "1", status: "want_fulltext", note: "keep", expected_version: 0 },
    ],
  });
  const second = e.ctx
    .listIssues({})
    .items.find((i) => i.issue_id === "issue1");
  assert.equal(second.unreviewed, 0);
  e.ctx.saveIssueReview({
    operation_id: "issue-operation-index",
    issue_key: second.issue_key,
    status: "completed",
    expected_version: 0,
    content_version: second.content_version,
  });
  assert.equal(e.ctx.listIssues({ status: "completed" }).total, 1);
  e.tables.Appearances.push([
    "s-new",
    "1",
    "issue1",
    "感染症",
    "",
    "new",
    "candidate",
    "",
    "test",
    "t2",
  ]);
  e.reindex();
  e.tables.Settings.find((r) => r[0] === "revision")[1] = "two";
  assert.equal(
    e.ctx.listIssues({}).items.find((i) => i.issue_id === "issue1")
      .content_changed,
    true,
  );
  assert.equal(
    e.ctx.listPapers({ tab: "all" }).items.find((p) => p.pmid === "1").review
      .note,
    "keep",
  );
  assert.equal(e.tables.IssueReviews[1][3], "completed");
  cache.clear();
  assert.equal(
    e.ctx.listIssues({}).items.find((i) => i.issue_id === "issue1").unreviewed,
    0,
  );
});

test("detail reads only indexed summary rows for the selected delivery, including cold cache", () => {
  const reads = [];
  const e = environment({
    indexed: true,
    cache: new Map(),
    onRead: (name, tables, range) => reads.push({ name, ...range }),
  });
  const detail = e.ctx.getPaperDetail({
    pmid: "1",
    issue_key: JSON.stringify(["issue2", "腎臓"]),
  });
  assert.equal(detail.appearances[0].text.one_line_assessment, "一行評価");
  assert.deepEqual(
    reads.filter((r) => r.name === "Texts"),
    [{ name: "Texts", row: 3, count: 1 }],
  );
});

test("partial cache eviction and concurrent sync cannot expose or retain mixed metadata", () => {
  const cache = new Map();
  let mutate = false;
  const e = environment({
    indexed: true,
    cache,
    onRead: (name, tables) => {
      if (mutate && name === "Reviews")
        tables.Settings.find((r) => r[0] === "revision")[1] = "changed";
    },
  });
  e.ctx.listIssues({});
  for (const k of cache.keys()) if (k.endsWith(":0")) cache.delete(k);
  assert.equal(e.ctx.listIssues({}).total, 2);
  cache.clear();
  mutate = true;
  assert.throws(() => e.ctx.listIssues({}), /同期中/);
  assert.equal(cache.size, 0);
});

test('read endpoints verify metadata once at the end, including later candidate and body reads', () => {
  const operations = [
    ['listPapers', {tab:'all'}, 'Appearances'],
    ['listIssuePapers', {issue_key:'["issue1","感染症"]'}, 'IssueCandidates'],
    ['getPaperDetail', {pmid:'1',issue_key:'["issue1","感染症"]'}, 'Texts'],
  ];
  for (const [method, request, lateTable] of operations) {
    const reads=[],cache=new Map();let change=false;
    const e=environment({indexed:true,candidates:true,cache,onRead:(name,tables)=>{
      reads.push(name);
      if(change && name===lateTable)tables.Settings.find(r=>r[0]==='revision')[1]='changed';
    }});
    e.ctx[method](request);
    assert.equal(reads.filter(n=>n==='Settings').length,2,method+' cold Settings');
    reads.length=0;e.ctx[method](request);
    assert.equal(reads.filter(n=>n==='Settings').length,2,method+' warm Settings');
    cache.clear();change=true;
    assert.throws(()=>e.ctx[method](request),/同期中/,method);
    assert.equal(cache.size,0,method+' must not publish unverified cache');
    assert.equal(e.writes(),0);
  }
});

test('saving still checks revision before appending and returns authoritative normal-ledger counts', () => {
  let mutate=false;
  const e=environment({indexed:true,candidates:true,onRead:(name,tables)=>{
    if(mutate&&name==='Reviews')tables.Settings.find(r=>r[0]==='revision')[1]='changed';
  }});
  const request={operation_id:'normal-ledger-save-001',changes:[{pmid:'1',status:'want_fulltext',note:'keep',expected_version:0}]};
  const first=e.ctx.saveReviews(request);
  assert.equal(first.counts.want,1);assert.equal(first.counts.done,0);
  e.ctx.saveReviews({...request,operation_id:'normal-ledger-save-002',changes:[{...request.changes[0],status:'read',expected_version:1}]});
  const retry=e.ctx.saveReviews(request);
  assert.equal(retry.replayed,true);assert.equal(retry.reviews[0].review.status,'read');
  assert.equal(retry.counts.want,0);assert.equal(retry.counts.done,1);
  const before=e.writes();mutate=true;
  assert.throws(()=>e.ctx.saveReviews({...request,operation_id:'normal-ledger-save-003'}),/同期中/);
  assert.equal(e.writes(),before);
});

test('cache publishes all parts and count together without a separate put', () => {
  const e=environment({indexed:true,cache:new Map()});
  const factory=e.ctx.CacheService.getUserCache;let batches=0,puts=0;
  e.ctx.CacheService.getUserCache=()=>{
    const cache=factory();return {...cache,put:(...args)=>{puts++;cache.put(...args);},putAll:(values,...args)=>{
      batches++;assert.ok(Object.keys(values).some(k=>!/:\d+$/.test(k)));cache.putAll(values,...args);
    }};
  };
  e.ctx.listIssues({});assert.equal(batches,1);assert.equal(puts,0);
  e.ctx.listIssues({});assert.equal(batches,1);
});
