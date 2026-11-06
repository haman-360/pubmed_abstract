import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runtime,seed,call} from '../runtime.mjs';
import {browseWindow,browseRange,readLimit} from '../browse.mjs';
const now='2026-11-05T03:00:00.000Z';

test('two calendar months use JST and clamp month ends; archive months validate dates',()=>{
  assert.deepEqual(browseWindow(new Date(now)),{from:'2026-09-05',through:'2026-11-05'});
  assert.deepEqual(browseWindow(new Date('2026-03-01T15:00:00Z')),{from:'2026-01-02',through:'2026-03-02'});
  assert.deepEqual(browseWindow(new Date('2026-04-30T15:00:00Z')),{from:'2026-03-01',through:'2026-05-01'});
  assert.deepEqual(browseWindow(new Date('2026-04-30T03:00:00Z')),{from:'2026-02-28',through:'2026-04-30'});
  assert.equal(browseRange({scope:'month',month:'2024-02'},new Date(now)).through,'2024-02-29');
  for(const month of ['2026-13','26-01','2026-02-01','1900-00','0001-01'])assert.throws(()=>browseRange({scope:'month',month},new Date(now)));
});

test('daily D1 read/write limits have a 24-hour retry hint; other errors do not',()=>{
  for(const kind of ['read','write']){
    const e=new Error(`D1_ERROR: Your account has exceeded D1's free tier daily row ${kind} limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.`);
    const hint=readLimit(e,new Date(now));assert.equal(hint.retry_after_seconds,86400);assert.equal(hint.retry_at,'2026-11-06T03:00:00.000Z');
    assert(hint.message.includes('24時間後'));assert(!hint.message.includes('Upgrade'));
    assert.equal(readLimit({message:'wrapped',cause:e},new Date(now)).error,'daily_d1_limit');
  }
  for(const message of ['D1_ERROR: Exceeded maximum DB size.','D1 DB exceeded its CPU time limit','D1_ERROR: no such table','offline'])assert.equal(readLimit(new Error(message)),null);
});

test('recent empty lists, historical months, unknown dates and quota responses preserve stored data',async t=>{
  const rt=await runtime({now});t.after(()=>rt.mf.dispose());await seed(rt.mf);
  const recent=await call(rt.mf,'listIssues',{scope:'recent'});assert.equal(recent.status,200);assert.equal(recent.value.total,0);assert.deepEqual(recent.value.items,[]);
  const past=await call(rt.mf,'listIssues',{scope:'month',month:'2026-08'});assert.equal(past.value.total,3);
  assert.equal((await call(rt.mf,'listIssues',{scope:'unknown'})).value.total,1);
  assert.equal((await call(rt.mf,'listIssues',{scope:'all'})).value.total,6);
  assert.equal((await call(rt.mf,'listIssues',{scope:'month',month:"2026-08' OR 1=1"})).status,400);
  const response=await rt.mf.dispatchFetch('http://127.0.0.1/api/listIssues',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer local-synthetic-owner','X-Local-Fault':'read-limit'},body:JSON.stringify({scope:'month',month:'2026-08'})});
  assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'86400');const hint=await response.json();assert.equal(hint.retry_at,'2026-11-06T03:00:00.000Z');
  assert.equal((await call(rt.mf,'listIssues',{scope:'month',month:'2026-08'})).value.total,3);
  assert.equal((await rt.db.prepare('SELECT count(*) n FROM issues').first()).n,6);
});

test('5000-paper browse reads indexed recent keys before progress and pages old months without deleting them',async t=>{
  const data=JSON.parse(execFileSync('python3',['-m','pmid_ledger.prototype.fixture','--scale','--browse'],{cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8',maxBuffer:30000000}));
  const rt=await runtime({now});t.after(()=>rt.mf.dispose());await seed(rt.mf,data);
  const recent=await call(rt.mf,'listIssues',{scope:'recent'}, {profile:true});assert.equal(recent.status,200);assert.equal(recent.value.total,20);assert.equal(recent.value.items.length,20);
  assert(recent.value.items.every(i=>i.delivered_date>='2026-09-05'));assert(recent.profile.rows_read<10000,`${recent.profile.rows_read} recent reads`);
  const old=await call(rt.mf,'listIssues',{scope:'month',month:'2025-01'},{profile:true});assert.equal(old.value.total,180);assert.equal(old.value.items.length,20);
  const next=await call(rt.mf,'listIssues',{scope:'month',month:'2025-01',offset:20});assert.equal(next.value.items.length,20);
  assert(!next.value.items.some(i=>old.value.items.some(j=>i.issue_key===j.issue_key)));
  const item=next.value.items[0],papers=await call(rt.mf,'listIssuePapers',{issue_key:item.issue_key});assert.equal(papers.status,200);
  const saved=await call(rt.mf,'saveReviews',{operation_id:crypto.randomUUID(),revision:papers.value.revision,changes:[{pmid:papers.value.items[0].pmid,expected_version:0,status:'want_fulltext',note:'old data retained'}]});assert.equal(saved.status,200);
  assert.equal((await rt.db.prepare('SELECT count(*) n FROM issues').first()).n,200);
  console.log(JSON.stringify({scope:'mixed-date-5000',recent_reads:recent.profile.rows_read,archive_page_reads:old.profile.rows_read,recent_total:20,archive_total:180}));
});
