import test from "node:test";
import assert from "node:assert/strict";
import { environment } from "./environment.mjs";
const key = '["issue1","感染症"]';
const change = { pmid: "1", status: "want_fulltext", note: "keep", expected_version: 0 };

test("delivery candidates read only target rows, cache metadata, and keep fresh manual state", () => {
  const reads = [], cache = new Map();
  const e = environment({ indexed: true, candidates: true, cache,
    onRead: (name, tables, range) => reads.push({name, ...range}) });
  let page = e.ctx.listIssuePapers({issue_key:key});
  assert.equal(page.items[0].score.total, "0");
  assert.equal(page.items[0].score.usefulness, "No (0/5)");
  assert.equal(page.issue.total, 1);
  assert.equal(reads.some(r => ["Papers","Appearances","Texts"].includes(r.name)), false);
  assert.deepEqual(reads.filter(r => r.name === "IssueCandidates"), [{name:"IssueCandidates", row:2, count:1}]);
  reads.length = 0;
  e.ctx.listIssuePapers({issue_key:key});
  assert.equal(reads.some(r => ["IssueCandidates","IssueCandidateRows"].includes(r.name)), false);
  reads.length = 0;
  const saved = e.ctx.saveReviews({issue_key:key, operation_id:"candidate-save-0001", changes:[change]});
  assert.equal(saved.issue.unreviewed, 0);
  assert.equal(saved.reviews[0].review.version, 1);
  assert.equal(reads.filter(r => r.name === "Reviews" && r.row === 1).length, 1);
  assert.equal(reads.some(r => ["Papers","Appearances","Texts"].includes(r.name)), false);
  assert.equal(e.ctx.listIssuePapers({issue_key:key}).items[0].review.status, "want_fulltext");
  const done = e.ctx.saveIssueReview({issue_key:key, operation_id:"candidate-done-0001", status:"completed", expected_version:0, content_version:saved.issue.content_version});
  assert.equal(done.issue.status, "completed");
  assert.equal(e.ctx.listIssuePapers({issue_key:key}).issue.status, "completed");
});

test("legacy candidates fall back honestly; missing delivery gives a sync instruction", () => {
  const e = environment();
  const page = e.ctx.listIssuePapers({issue_key:key});
  assert.equal(page.scores_available, false);
  assert.equal(page.items[0].score, null);
  assert.throws(() => e.ctx.listIssuePapers({issue_key:'["new","感染症"]'}), /未同期/);
  const indexed = environment({indexed:true,candidates:true});
  assert.equal(indexed.ctx.listIssuePapers({issue_key:key,query:"no-match"}).total,0);
  assert.equal(indexed.ctx.listIssuePapers({issue_key:key,status:"read"}).total,0);
  assert.equal(indexed.ctx.listIssuePapers({issue_key:key,query:"1"}).total,1);
  assert.throws(() => indexed.ctx.listIssuePapers({issue_key:key,offset:-1}), /ページ/);
});

test("candidate cache revision and retries cannot hide later reviews or duplicate writes", () => {
  const cache = new Map(), e = environment({indexed:true,candidates:true,cache});
  e.ctx.listIssuePapers({issue_key:key});
  e.tables.IssueCandidates[1][5] = "22";
  e.tables.Settings.find(r => r[0] === "revision")[1] = "two";
  assert.equal(e.ctx.listIssuePapers({issue_key:key}).items[0].score.total,"22");
  const request = {issue_key:key,operation_id:"candidate-retry-001",changes:[change]};
  e.ctx.saveReviews(request);
  e.ctx.saveReviews({issue_key:key,operation_id:"candidate-other-001",changes:[{...change,status:"read",expected_version:1}]});
  const retry = e.ctx.saveReviews(request);
  assert.equal(retry.replayed,true);
  assert.equal(retry.reviews[0].review.status,"read");
  assert.equal(retry.reviews[0].review.version,2);
  assert.equal(e.tables.Reviews.length,3);
  assert.throws(() => e.ctx.saveReviews({issue_key:key,operation_id:"candidate-outside-1",changes:[{...change,pmid:"10"}]}),/対象配信/);
  assert.throws(() => e.ctx.saveReviews({...request,operation_id:"candidate-conflict",changes:[change]}),/更新/);
});

test("metadata changes during candidate read cannot return mixed data", () => {
  let mutate = false;
  const e = environment({indexed:true,candidates:true,cache:new Map(),onRead:(name,tables) => {
    if (mutate && name === "IssueCandidates") tables.Settings.find(r => r[0] === "revision")[1] = "changed";
  }});
  mutate = true;
  assert.throws(() => e.ctx.listIssuePapers({issue_key:key}), /同期中/);
});
