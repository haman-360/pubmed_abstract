import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { environment } from "./environment.mjs";

// Exercise the delivered client and its event handlers against the GAS fixture.
function client(count = 15) {
  const e = environment({ indexed: true, candidates: true });
  for (let id = 100; id < 100 + count - 1; id++) {
    const paper = [...e.tables.Papers[1]];
    paper[0] = String(id);
    e.tables.Papers.push(paper);
    const appearance = [...e.tables.Appearances[1]];
    appearance[0] = "fixture-" + id;
    appearance[1] = String(id);
    e.tables.Appearances.push(appearance);
  }
  e.reindex();
  function element(tag = "div") {
    const n = {
      tag, children: [], textContent: "", className: "", value: "", dataset: {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(key, value) { this[key] = value; },
      reset() {},
    };
    n.classList = {
      toggle(cls, enabled) {
        const classes = new Set(n.className.split(/\s+/).filter(Boolean));
        if (enabled) classes.add(cls); else classes.delete(cls);
        n.className = [...classes].join(" ");
      },
      add(cls) { this.toggle(cls, true); },
      contains(cls) { return n.className.split(/\s+/).includes(cls); },
    };
    return n;
  }
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const walk = (n) => [n, ...n.children.flatMap(walk)];
  const document = {
    body: { dataset: {} }, getElementById: get, createElement: element,
    querySelectorAll(selector) {
      const all = [...nodes.values()].flatMap(walk);
      if (selector === ".issue-hint") return all.filter((n) => n.classList.contains("issue-hint"));
      if (selector.includes(".issue-progress"))
        return [get("issue-context"), get("issue-footer")].flatMap(walk)
          .filter((n) => n.classList.contains("issue-progress"));
      if (selector.includes("complete-issue"))
        return all.filter((n) => n.dataset.completeIssue === "true");
      if (selector.includes("complete-blocked"))
        return all.filter((n) => n.dataset.completeBlocked === "true");
      return all.filter((n) => ["button", "select", "input", "textarea"].includes(n.tag));
    },
  };
  const ctx = vm.createContext({
    document, window: { addEventListener() {} }, URL, crypto,
    setTimeout: () => 0, clearTimeout() {}, confirm: () => true,
    google: { script: { run: {
      withSuccessHandler() { return this; }, withFailureHandler() { return this; },
      listIssues() {},
    } } },
  });
  const html = fs.readFileSync(new URL("../gas/Index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  vm.runInContext(scripts[1][1], ctx);
  const calls = [];
  ctx.callServer = (name, arg) => { calls.push(name); return e.ctx[name](arg); };
  vm.runInContext(`rpc = async (name, arg) => callServer(name, arg);
    busy = false; switchView(false);
    activeFilter = {tab: "all", issue_key: '["issue1","感染症"]'};`, ctx);
  const run = (code) => vm.runInContext(code, ctx);
  const all = (id) => walk(get(id));
  const button = (id, label) => all(id).find((n) => n.tag === "button" && n.textContent === label);
  const select = (index) => walk(get("papers").children[index]).find((n) => n.tag === "select");
  const choose = (index, value) => { const n = select(index); n.value = value; n.onchange(); };
  const progress = (id) => all(id).find((n) => n.className === "issue-progress").textContent;
  return { e, get, run, all, button, choose, progress, calls };
}

test("footer shows live whole-delivery progress and only wanted cards turn yellow", async () => {
  const c = client();
  await c.run("load()");
  assert.equal(c.get("paper-pagination").hidden, true);
  assert.equal(c.progress("issue-footer"), "未確認 ｜ 振り分け済み 0 / 15件");
  c.choose(0, "want_fulltext");
  c.choose(1, "reviewed_no_fulltext");
  assert.match(c.progress("issue-footer"), /2 \/ 15件（未保存の変更 2件を含む）/);
  assert.equal(c.progress("issue-context"), c.progress("issue-footer"));
  assert.equal(c.get("papers").children[0].classList.contains("want-fulltext"), true);
  assert.equal(c.get("papers").children[1].classList.contains("want-fulltext"), false);
  assert.ok(c.all("papers").some((n) => n.textContent === "原文入手希望（未保存）"));
  c.choose(0, "unreviewed");
  assert.match(c.progress("issue-footer"), /1 \/ 15件/);
  assert.equal(c.get("papers").children[0].classList.contains("want-fulltext"), false);
  assert.equal(c.e.writes(), 0);
});

test("bottom controls save, complete and return; failed save retains drafts", async () => {
  const c = client(2);
  await c.run("load()");
  c.choose(0, "want_fulltext");
  c.choose(1, "reviewed_no_fulltext");
  assert.equal(c.button("issue-footer", "保存して確認完了").disabled, false);
  const callServer = c.e.ctx.saveReviews;
  c.e.ctx.saveReviews = () => { throw new Error("save failed"); };
  await c.get("save-drafts").onclick();
  await new Promise(setImmediate);
  assert.match(c.progress("issue-footer"), /未保存の変更 2件/);
  c.e.ctx.saveReviews = callServer;
  await c.get("save-drafts").onclick();
  await new Promise(setImmediate);
  assert.equal(c.progress("issue-footer"), "未確認 ｜ 振り分け済み 2 / 2件");
  assert.equal(c.button("issue-footer", "保存して確認完了").disabled, false);
  await c.button("issue-footer", "保存して確認完了").onclick();
  assert.equal(c.progress("issue-footer"), "確認済み ｜ 振り分け済み 2 / 2件");
  assert.equal(c.get("papers").children[0].classList.contains("want-fulltext"), true);
  c.button("issue-footer", "配信一覧に戻る").onclick();
  assert.equal(c.get("paper-view").hidden, true);
});

test("pagination works beyond 50 papers and keeps draft progress across pages", async () => {
  const c = client(51);
  await c.run("load()");
  assert.equal(c.get("paper-pagination").hidden, false);
  assert.equal(c.get("prev").disabled, true);
  assert.equal(c.get("next").disabled, false);
  c.choose(0, "want_fulltext");
  c.get("next").onclick();
  await c.run("Promise.resolve()");
  assert.equal(c.get("papers").children.length, 1);
  assert.equal(c.get("prev").disabled, false);
  assert.equal(c.get("next").disabled, true);
  assert.match(c.progress("issue-footer"), /1 \/ 51件/);
  c.get("prev").onclick();
  await c.run("Promise.resolve()");
  assert.equal(c.get("papers").children.length, 50);
  assert.equal(c.get("papers").children[0].classList.contains("want-fulltext"), true);
  for (let i = 1; i < 50; i++) c.choose(i, "reviewed_no_fulltext");
  c.get("next").onclick();
  await c.run("Promise.resolve()");
  c.choose(0, "want_fulltext");
  assert.match(c.progress("issue-footer"), /51 \/ 51件/);
  await c.get("save-drafts").onclick();
  await new Promise(setImmediate);
  assert.doesNotMatch(c.progress("issue-footer"), /未保存/);
  await c.button("issue-footer", "保存して確認完了").onclick();
  assert.equal(c.progress("issue-footer"), "確認済み ｜ 振り分け済み 51 / 51件");
});

test("one click saves and completes without reloading cards or clearing selection and notes", async () => {
  const c = client(2); await c.run("load()");
  const card = c.get("papers").children[0];
  const note = c.all("papers").find(n => n.tag === "textarea");
  note.value = "自分用メモ"; note.oninput();
  c.choose(0,"want_fulltext"); c.choose(1,"reviewed_no_fulltext");
  const check = c.all("papers").find(n => n.tag === "input"); check.checked = true; check.onchange();
  c.calls.length = 0;
  const done = c.button("issue-footer","保存して確認完了");
  await Promise.all([done.onclick(), done.onclick()]);
  assert.deepEqual(c.calls, ["saveReviews","saveIssueReview"]);
  assert.equal(c.get("papers").children[0],card);
  assert.equal(note.value,"自分用メモ"); assert.equal(check.checked,true);
  assert.match(c.progress("issue-footer"), /^確認済み/);
  assert.equal(c.e.tables.Reviews.length,3);
  assert.equal(c.e.tables.IssueReviews.length,2);
});

test("completion failure retries completion only; save-response loss reuses the operation", async () => {
  const c = client(2); await c.run("load()");
  c.choose(0,"want_fulltext"); c.choose(1,"reviewed_no_fulltext");
  const save = c.e.ctx.saveReviews;
  let lose = true;
  c.e.ctx.saveReviews = arg => { const result = save(arg); if (lose) { lose=false; throw new Error("response lost"); } return result; };
  await c.button("issue-footer","保存して確認完了").onclick();
  assert.match(c.progress("issue-footer"), /未保存/);
  const complete = c.e.ctx.saveIssueReview;
  c.e.ctx.saveIssueReview = () => { throw new Error("completion failed"); };
  await c.button("issue-footer","保存して確認完了").onclick();
  assert.equal(c.e.tables.Reviews.length,3);
  assert.doesNotMatch(c.progress("issue-footer"),/未保存/);
  assert.match(c.get("feedback").textContent,/編集は保存済み・配信確認は未完了/);
  c.e.ctx.saveIssueReview = complete; c.calls.length = 0;
  await c.button("issue-footer","保存して確認完了").onclick();
  assert.deepEqual(c.calls,["saveIssueReview"]);
  assert.match(c.progress("issue-footer"),/^確認済み/);
});

test("a delivery content change after paper saving prevents automatic completion", async () => {
  const c = client(2); await c.run("load()");
  c.choose(0,"want_fulltext"); c.choose(1,"reviewed_no_fulltext");
  const save = c.e.ctx.saveReviews;
  c.e.ctx.saveReviews = arg => { const result = save(arg); result.issue.content_version = "changed"; return result; };
  c.calls.length = 0;
  await c.button("issue-footer","保存して確認完了").onclick();
  assert.deepEqual(c.calls,["saveReviews"]);
  assert.match(c.get("feedback").textContent,/配信内容が更新/);
  assert.equal(c.e.tables.IssueReviews.length,1);
});
