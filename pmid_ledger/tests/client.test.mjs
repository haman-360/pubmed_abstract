import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { environment } from "./environment.mjs";

// Exercise the delivered client and its event handlers against the GAS fixture.
function client(count = 15) {
  const e = environment({ indexed: true });
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
      if (selector.includes(".issue-progress"))
        return [get("issue-context"), get("issue-footer")].flatMap(walk)
          .filter((n) => n.classList.contains("issue-progress"));
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
  ctx.callServer = (name, arg) => e.ctx[name](arg);
  vm.runInContext(`rpc = async (name, arg) => callServer(name, arg);
    busy = false; switchView(false);
    activeFilter = {tab: "all", issue_key: '["issue1","感染症"]'};`, ctx);
  const run = (code) => vm.runInContext(code, ctx);
  const all = (id) => walk(get(id));
  const button = (id, label) => all(id).find((n) => n.tag === "button" && n.textContent === label);
  const select = (index) => get("papers").children[index].children.find((n) => n.className === "actions").children[0];
  const choose = (index, value) => { const n = select(index); n.value = value; n.onchange(); };
  const progress = (id) => all(id).find((n) => n.className === "issue-progress").textContent;
  return { e, get, run, all, button, choose, progress };
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
  assert.equal(c.button("issue-footer", "この配信を確認済みにする").disabled, true);
  const callServer = c.e.ctx.saveReviews;
  c.e.ctx.saveReviews = () => { throw new Error("save failed"); };
  await c.get("save-drafts").onclick();
  await new Promise(setImmediate);
  assert.match(c.progress("issue-footer"), /未保存の変更 2件/);
  c.e.ctx.saveReviews = callServer;
  await c.get("save-drafts").onclick();
  await new Promise(setImmediate);
  assert.equal(c.progress("issue-footer"), "未確認 ｜ 振り分け済み 2 / 2件");
  assert.equal(c.button("issue-footer", "この配信を確認済みにする").disabled, false);
  await c.button("issue-footer", "この配信を確認済みにする").onclick();
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
});
