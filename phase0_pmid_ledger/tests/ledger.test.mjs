import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { papers, appearances, settings, title } from '../fixtures.mjs';
const source = fs.readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function environment(options = {}) {
  const ctx = vm.createContext({}); vm.runInContext(source, ctx);
  let writes = 0, released = 0;
  const values = { Papers: [plain(ctx.Phase0.paperHeaders), ...papers.map(p => plain(ctx.Phase0.paperHeaders).map(h => p[h]))],
    Appearances: [plain(ctx.Phase0.snapshotHeaders), ...appearances.map(p => plain(ctx.Phase0.snapshotHeaders).map(h => p[h]))], _Settings: structuredClone(settings) };
  const sheet = name => ({ getLastRow: () => values[name].length, getRange: (r, c, nr = 1, nc = 1) => {
    if (typeof r === 'string') [r, c, nr, nc] = [1, 1, 3, 2];
    const get = () => values[name].slice(r - 1, r - 1 + nr).map(row => row.slice(c - 1, c - 1 + nc));
    return { getValues: () => plain(get()), getDisplayValues: () => get().map(row => row.map(String)), setValues: data => {
      if (options.writeError) throw new Error('simulated storage outage');
      assert.equal(name, 'Papers'); assert.equal(c, 5); assert.equal(nc, 4); assert.equal(nr, 1);
      writes++; values[name][r - 1].splice(c - 1, nc, ...data[0]);
    }};
  }});
  ctx.Session = { getActiveUser: () => ({getEmail: () => options.active === undefined ? 'owner@example.test' : options.active}), getEffectiveUser: () => ({getEmail: () => 'owner@example.test'}) };
  ctx.PropertiesService = { getScriptProperties: () => ({getProperty: () => options.noOwner ? '' : 'owner@example.test'}) };
  ctx.SpreadsheetApp = { openById: id => { assert.equal(id, ctx.PHASE0_SPREADSHEET_ID); return {getName: () => options.wrongTitle ? 'PRODUCTION' : title, getSheetByName: sheet}; }, flush() { if (options.flushError) throw new Error('flush failed'); } };
  ctx.LockService = {getScriptLock: () => ({tryLock: () => !options.locked, releaseLock: () => released++})};
  ctx.Utilities = {formatDate: () => '2026-08-30'};
  return {ctx, values, writes: () => writes, released: () => released};
}
const request = (extra = {}) => ({pmid:'1', status:'want_fulltext', expected_version:0, operation_id:'test-operation-00001', ...extra});
test('default recent list has two samples; old pending remains in all-time tabs', () => {
  const {ctx} = environment(); const data = ctx.listPapers({});
  assert.deepEqual(plain(data.counts), {recent:2,want:1,obtained:1,old:2,done:2});
  assert.deepEqual(plain(data.items.map(p=>p.pmid)), ['1','2']);
  assert.equal(ctx.listPapers({tab:'want'}).items[0].pmid,'10');
  assert.equal(ctx.listPapers({tab:'obtained'}).items[0].pmid,'20');
});
test('three calendar months clamp month ends; boundary inclusive; unknown old', () => {
  const {Phase0:p}=environment().ctx;
  assert.equal(p.cutoff('2026-05-31'),'2026-02-28'); assert.equal(p.cutoff('2024-05-31'),'2024-02-29'); assert.equal(p.cutoff('2026-01-31'),'2025-10-31');
  assert.equal(p.category({...papers[0],reference_date:'2026-05-30'},'2026-05-30','2026-08-30'),'recent');
  assert.equal(p.category({...papers[0],reference_date:''},'2026-05-30','2026-08-30'),'old');
});
test('pagination caps response at 50 and numeric PMID ordering breaks ties', () => {
  const {Phase0:p}=environment().ctx;
  const records=Array.from({length:75},(_,i)=>({...papers[0],pmid:String(75-i)}));
  assert.equal(p.list(records,{},'2026-08-30').items.length,50);
  assert.deepEqual(plain(p.list(records,{offset:50},'2026-08-30').items.map(x=>x.pmid)),Array.from({length:25},(_,i)=>String(i+51)));
  assert.throws(()=>p.list(records,{offset:-1},'2026-08-30'));
});
test('save survives re-read and never writes notes or snapshots', () => {
  const env=environment(), before=structuredClone(env.values.Appearances);
  const result=env.ctx.changeStatus(request());
  assert.equal(result.saved,true); assert.equal(env.ctx.getPaperDetail('1').paper.review_status,'want_fulltext');
  assert.equal(result.paper.note,papers[0].note); assert.deepEqual(env.values.Appearances,before);
  assert.equal(env.writes(),1); assert.equal(env.released(),1);
});
test('retry after lost response is idempotent; stale other device rejected', () => {
  const env=environment(); env.ctx.changeStatus(request()); env.ctx.changeStatus(request()); assert.equal(env.writes(),1);
  assert.throws(()=>env.ctx.changeStatus(request({operation_id:'test-operation-other'})),/別の画面/);
  assert.equal(env.writes(),1);
});
test('simulated save failure preserves all values and returns no success', () => {
  const env=environment(), before=structuredClone(env.values);
  assert.throws(()=>env.ctx.changeStatus(request({simulate_failure:true})),/TEST：保存前/);
  assert.deepEqual(env.values,before); assert.equal(env.writes(),0); assert.equal(env.released(),1);
});
test('storage and flush failures never return saved=true', () => {
  for (const opts of [{writeError:true},{flushError:true}]) {const e=environment(opts); assert.throws(()=>e.ctx.changeStatus(request())); assert.equal(e.released(),1);}
});
test('owner authentication fails closed before spreadsheet writes', () => {
  for(const opts of [{active:''},{active:'other@example.test'},{noOwner:true}]) {
    const e=environment(opts); assert.throws(()=>e.ctx.listPapers({}),/本人認証/); assert.throws(()=>e.ctx.changeStatus(request()),/本人認証/); assert.equal(e.writes(),0);
  }
});
test('wrong title, marker or locked resource prevents writes', () => {
  for(const opts of [{wrongTitle:true},{locked:true}]) { const e=environment(opts); assert.throws(()=>e.ctx.changeStatus(request())); assert.equal(e.writes(),0); }
  const e=environment(); e.values._Settings[1][1]='PRODUCTION'; assert.throws(()=>e.ctx.changeStatus(request()),/TEST識別/); assert.equal(e.writes(),0);
});
test('malformed/duplicate records and invalid status rejected', () => {
  const e=environment(); assert.throws(()=>e.ctx.changeStatus(request({status:'delivery_completed'})),/確認状態/);
  e.values.Papers.push([...e.values.Papers[1]]); assert.throws(()=>e.ctx.listPapers({}),/重複/);
});
test('snapshot detail preserves separate issue summaries and empty summary for candidate', () => {
  const {ctx}=environment(); const detail=ctx.getPaperDetail('1');
  assert.equal(detail.appearances.length,2); assert.notEqual(detail.appearances[0].summary_ja,detail.appearances[1].summary_ja);
  const candidate=ctx.getPaperDetail('2').appearances[0]; assert.equal(candidate.summary_ja,''); assert.match(candidate.one_line_assessment,/一行評価/);
  assert.equal(ctx.getPaperDetail('4').appearances.length,0);
});
test('TXT is numeric sorted, deduplicated, UTF-8, no BOM, LF only; no other state exported', () => {
  const {Phase0:p}=environment().ctx;
  const data=p.exportText([...papers,...['100','2','10','2'].map(pmid=>({...papers[0],pmid,review_status:'want_fulltext'}))]);
  const bytes=Buffer.from(data.text,'utf8'); assert.equal(data.text,'2\n10\n100\n'); assert.equal(data.count,3);
  assert.notEqual(bytes.subarray(0,3).toString('hex'),'efbbbf'); assert.equal(bytes.toString('utf8'),data.text);
  assert.equal(p.exportText([]).text,''); assert.throws(()=>p.exportText([{pmid:'1 x',review_status:'want_fulltext'}]));
});
test('TEST GAS deploy has no external calls, triggers, AI SDKs, or public access', () => {
  const html=fs.readFileSync(new URL('../Index.html',import.meta.url),'utf8');
  const manifest=JSON.parse(fs.readFileSync(new URL('../appsscript.json',import.meta.url),'utf8'));
  assert.doesNotMatch(source,/UrlFetchApp|DriveApp|DocumentApp|ScriptApp|https:\/\/api\.openai|fetch\(/);
  assert.doesNotMatch(html,/fetch\(|XMLHttpRequest|<script[^>]+src=/);
  assert.equal(manifest.webapp.access,'MYSELF'); assert.equal(manifest.webapp.executeAs,'USER_ACCESSING');
  assert.deepEqual(manifest.oauthScopes,['https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/userinfo.email']);
});
