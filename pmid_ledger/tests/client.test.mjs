import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { environment } from "./environment.mjs";

// Exercise the delivered client and its event handlers against the GAS fixture.
function client(count = 15, profiling = false, profileWrites = false) {
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
    body: { dataset: { profile: profiling ? "1" : "", profileWrites: profileWrites ? "1" : "" } }, getElementById: get, createElement: element,
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
      listIssues() {}, profileLedger() {},
    } } },
  });
  const html = fs.readFileSync(new URL("../gas/Index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  vm.runInContext(scripts[1][1], ctx);
  const calls = [];
  ctx.callServer = (name, arg) => { calls.push(name); return e.ctx[name](arg); };
  vm.runInContext(`var rawRpc = rpc; rpc = async (name, arg) => callServer(name, arg);
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
  assert.deepEqual(c.calls, ["saveAndCompleteIssue"]);
  assert.equal(c.get("papers").children[0],card);
  assert.equal(note.value,"自分用メモ"); assert.equal(check.checked,true);
  assert.match(c.progress("issue-footer"), /^確認済み/);
  assert.equal(c.e.tables.Reviews.length,3);
  assert.equal(c.e.tables.IssueReviews.length,2);
});

test("partial completion failure retries the original combined request without duplicating paper saves", async () => {
  const c = client(2); await c.run("load()");
  c.choose(0,"want_fulltext"); c.choose(1,"reviewed_no_fulltext");
  const complete = c.e.ctx.saveIssueReviewInContext_;
  c.e.ctx.saveIssueReviewInContext_ = () => { throw new Error("completion failed"); };
  await c.button("issue-footer","保存して確認完了").onclick();
  assert.equal(c.e.tables.Reviews.length,3);
  assert.doesNotMatch(c.progress("issue-footer"),/未保存/);
  assert.match(c.get("feedback").textContent,/編集は保存済み・配信の確認完了は確認できません/);
  const packet = c.run('JSON.stringify(completionAttempt.request)');
  c.e.ctx.saveIssueReviewInContext_ = complete; c.calls.length = 0;
  await c.button("issue-footer","保存して確認完了").onclick();
  assert.deepEqual(c.calls,["saveAndCompleteIssue"]);
  assert.equal(c.e.tables.Reviews.length,3);assert.equal(c.e.tables.IssueReviews.length,2);
  assert.equal(c.run('completionAttempt'),null);
  assert.match(c.progress("issue-footer"),/^確認済み/);
  assert.ok(packet.includes('review_operation_id'));
});

test("lost combined response reuses both IDs and cannot append the completion twice", async () => {
  const c = client(2); await c.run("load()");
  c.choose(0,"want_fulltext"); c.choose(1,"reviewed_no_fulltext");
  const save=c.e.ctx.saveAndCompleteIssue;let lose=true;const packets=[];
  c.e.ctx.saveAndCompleteIssue=request=>{packets.push(JSON.stringify(request));const result=save(request);if(lose){lose=false;throw new Error('response lost');}return result;};
  await c.button('issue-footer','保存して確認完了').onclick();
  assert.match(c.progress('issue-footer'),/未保存/);
  await c.button('issue-footer','保存して確認完了').onclick();
  assert.equal(packets[0],packets[1]);assert.equal(c.e.tables.Reviews.length,3);
  assert.equal(c.e.tables.IssueReviews.length,2);assert.match(c.progress('issue-footer'),/^確認済み/);
});

test("metadata changes between the two save stages retain confirmed edits and block completion", async () => {
  const c = client(2); await c.run("load()");
  c.choose(0,"want_fulltext"); c.choose(1,"reviewed_no_fulltext");
  const save=c.e.ctx.saveReviewsInContext_;
  c.e.ctx.saveReviewsInContext_=(...args)=>{const result=save(...args);c.e.tables.Settings.find(r=>r[0]==='revision')[1]='changed';return result;};
  c.calls.length=0;await c.button('issue-footer','保存して確認完了').onclick();
  assert.deepEqual(c.calls,['saveAndCompleteIssue']);
  assert.doesNotMatch(c.progress('issue-footer'),/未保存/);
  assert.match(c.get('feedback').textContent,/編集は保存済み/);
  assert.equal(c.e.tables.IssueReviews.length,1);
});

test("client timing separates RPC/server/frame time and never records request or response content", async () => {
  const c = client(2, true, true);
  c.run(`var frameQueue = [], testClock = 0;
    performance = { now: () => testClock };
    requestAnimationFrame = fn => frameQueue.push(fn);
    google.script.run = {
      withSuccessHandler(fn) { this.success = fn; return this; },
      withFailureHandler(fn) { this.failure = fn; return this; },
      profileLedger(request) { testClock = 120; this.success({ok: true, value: {secret: 'PRIVATE RESPONSE'},
        profile: {schema: 'PMID_TIMING_V1', request_id: request.request_id, method: request.method, total_ms: 40, spans: []}}); }
    };`);
  const result = await c.run(`rawRpc('listIssues', {query: 'PRIVATE QUERY'})`);
  assert.equal(result.secret, 'PRIVATE RESPONSE');
  let samples = JSON.parse(c.run('JSON.stringify(timingSamples)'));
  assert.equal(samples[0].roundtrip_ms, 120);
  assert.equal(samples[0].outside_server_ms, 80);
  assert.equal(samples[0].response_to_frame_ms, null);
  c.run('testClock = 125; frameQueue.shift()(); testClock = 140; frameQueue.shift()();');
  samples = JSON.parse(c.run('JSON.stringify(timingSamples)'));
  assert.equal(samples[0].response_to_frame_ms, 20);
  assert.doesNotMatch(JSON.stringify(samples), /PRIVATE/);
});

test("production diagnostic client blocks saves before sending an RPC", async () => {
  const c = client(2, true, false);
  c.run(`google.script.run = { withSuccessHandler() { throw new Error('unexpected network'); } };`);
  await assert.rejects(c.run(`rawRpc('saveReviews', {note: 'PRIVATE'})`), /本番台帳の計測モード/);
  assert.equal(c.run('timingSamples.length'), 0);
});

test("client timeout and failed response record outcome, retain original retry behavior and ignore late replies", async () => {
  const c = client(2, true, true);
  c.run(`var timeoutCallback, lateSuccess;
    setTimeout = fn => { timeoutCallback = fn; return 1; };
    clearTimeout = () => {};
    google.script.run = {
      withSuccessHandler(fn) { lateSuccess = fn; return this; },
      withFailureHandler() { return this; }, profileLedger() {}
    };`);
  const pending = c.run(`rawRpc('saveReviews', {operation_id: 'same-operation-id'})`);
  c.run('timeoutCallback();');
  await assert.rejects(pending, /保存の応答を確認できません/);
  c.run('lateSuccess({ok: true, profile: {request_id: timingSamples[0].request_id, total_ms: 31000, spans: []}});');
  assert.equal(c.run('timingSamples.length'), 1);
  assert.equal(c.run('timingSamples[0].outcome'), 'timeout');
  assert.equal(c.run('timingSamples[0].late_server.total_ms'), 31000);
});

test('normal PMID save applies confirmed states and counts without refetching or rebuilding cards', async () => {
  const c=client(2);
  await c.run("activeFilter={tab:'all',status:'unreviewed'}; load()");
  const card=c.get('papers').children[0];
  const note=c.all('papers').find(n=>n.tag==='textarea');note.value='retain note';note.oninput();
  c.choose(0,'want_fulltext');c.calls.length=0;
  await c.get('save-drafts').onclick();await new Promise(setImmediate);
  assert.deepEqual(c.calls,['saveReviews']);
  assert.equal(c.get('papers').children[0],card);assert.equal(note.value,'retain note');
  assert.equal(c.run('current.counts.want'),1);assert.equal(c.run('current.list_stale'),true);
  assert.match(c.get('range').textContent,/再読み込みで更新/);
  assert.equal(c.run('drafts.size'),0);
  c.calls.length=0;await c.run('load()');assert.deepEqual(c.calls,['listPapers']);
  assert.equal(c.run('current.list_stale'),undefined);
});

test('return reuses only a recent unchanged matching delivery list; opening and explicit reload fetch fresh data', async () => {
  const c=client(2);
  c.get('issue-status').value='open';
  await c.run('switchView(true); loadIssues()');
  await c.run(`openIssue('["issue1","感染症"]')`);await new Promise(setImmediate);
  c.calls.length=0;c.run('showIssues()');await new Promise(setImmediate);
  assert.deepEqual(c.calls,[]);assert.match(c.get('feedback').textContent,/直前に取得/);
  c.run(`openIssue('["issue1","感染症"]')`);await new Promise(setImmediate);
  assert.deepEqual(c.calls,['listIssuePapers']);
  c.run('showIssues()');await new Promise(setImmediate);c.calls.length=0;
  await c.get('issue-refresh').onclick();assert.deepEqual(c.calls,['listIssues']);
  c.run(`openIssue('["issue1","感染症"]')`);await new Promise(setImmediate);
  c.run('issueListLoadedAt-=61000');c.calls.length=0;c.run('showIssues()');await new Promise(setImmediate);
  assert.deepEqual(c.calls,['listIssues']);
});

test('delivery list cannot be reused after saves, failed saves, changed filters, or failed fetches', async () => {
  for(const mode of ['save','failed-save','filter','failed-fetch']){
    const c=client(2);c.get('issue-status').value='open';
    await c.run('switchView(true); loadIssues()');
    c.run(`openIssue('["issue1","感染症"]')`);await new Promise(setImmediate);
    if(mode.includes('save')){
      c.choose(0,'want_fulltext');
      if(mode==='failed-save')c.e.ctx.saveReviews=()=>{throw new Error('unknown response');};
      await c.get('save-drafts').onclick();await new Promise(setImmediate);
    }else if(mode==='filter')c.get('issue-status').value='all';
    else{
      const list=c.e.ctx.listIssues;c.e.ctx.listIssues=()=>{throw new Error('service unavailable');};
      await c.run('loadIssues()');c.e.ctx.listIssues=list;
    }
    c.calls.length=0;c.run('showIssues()');await new Promise(setImmediate);
    assert.deepEqual(c.calls,['listIssues'],mode);
  }
});

test('normal-save lost response retries the same operation and applies newer confirmed state and counts', async () => {
  const c=client(2);await c.run("activeFilter={tab:'all'}; load()");
  const card=c.get('papers').children[0];c.choose(0,'want_fulltext');
  const original=c.e.ctx.saveReviews;let lose=true;
  c.e.ctx.saveReviews=arg=>{const result=original(arg);if(lose){lose=false;throw new Error('response lost');}return result;};
  await c.get('save-drafts').onclick();await new Promise(setImmediate);
  assert.equal(c.run('drafts.size'),1);
  original({operation_id:'other-client-newer-save',changes:[{pmid:'1',status:'read',note:'newer confirmed note',expected_version:1}]});
  c.calls.length=0;await c.get('save-drafts').onclick();await new Promise(setImmediate);
  assert.deepEqual(c.calls,['saveReviews']);assert.equal(c.e.tables.Reviews.length,3);
  assert.equal(c.get('papers').children[0],card);assert.equal(c.run('drafts.size'),0);
  assert.equal(c.run("current.items.find(p=>p.pmid==='1').review.status"),'read');
  assert.equal(c.run('current.counts.want'),0);assert.equal(c.run('current.counts.done'),1);
  assert.ok(c.all('papers').some(n=>n.tag==='textarea'&&n.value==='newer confirmed note'));
});


test('all 51 edits across two pages save and complete through one request', async () => {
  const c=client(51);await c.run('load()');
  for(let i=0;i<50;i++)c.choose(i,'want_fulltext');
  c.get('next').onclick();await new Promise(setImmediate);c.choose(0,'reviewed_no_fulltext');
  c.calls.length=0;await c.button('issue-footer','保存して確認完了').onclick();
  assert.deepEqual(c.calls,['saveAndCompleteIssue']);assert.equal(c.e.tables.Reviews.length,52);
  assert.equal(c.e.tables.IssueReviews.length,2);assert.equal(c.run('drafts.size'),0);
  assert.match(c.progress('issue-footer'),/^確認済み.*51 \/ 51件/);
});

test('new edits after a confirmed paper-only save receive new operation IDs', async () => {
  const c=client(2);await c.run('load()');c.choose(0,'want_fulltext');c.choose(1,'reviewed_no_fulltext');
  const complete=c.e.ctx.saveIssueReviewInContext_;c.e.ctx.saveIssueReviewInContext_=()=>{throw new Error('unavailable');};
  await c.button('issue-footer','保存して確認完了').onclick();
  const first=JSON.parse(c.run('JSON.stringify(completionAttempt.request)'));
  c.choose(0,'read');c.e.ctx.saveIssueReviewInContext_=complete;
  const combined=c.e.ctx.saveAndCompleteIssue;let second;
  c.e.ctx.saveAndCompleteIssue=request=>{second=JSON.parse(JSON.stringify(request));return combined(request);};
  await c.button('issue-footer','保存して確認完了').onclick();
  assert.notEqual(first.operation_id,second.operation_id);assert.notEqual(first.review_operation_id,second.review_operation_id);
  assert.equal(c.e.tables.Reviews.length,4);assert.match(c.progress('issue-footer'),/^確認済み/);
});
