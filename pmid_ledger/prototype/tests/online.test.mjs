import test from 'node:test';
import assert from 'node:assert/strict';
import {OnlineEdits} from '../online-state.mjs';
import {onlineAssets} from '../online-build.mjs';
import {runtime,seedDatabase} from '../runtime.mjs';
import {identityFixture,certificate} from './identity-fixture.mjs';
const issue={issue_key:'["synthetic-small","感染症"]',version:0,content_version:'synthetic-content'},revision='a'.repeat(64);
const row=(pmid='1')=>({pmid,review:{version:0,status:'unreviewed',note:''}});
test('online drafts retain original versions across pages; unknown outcomes retry the same complete operation',()=>{
  let id=0;const state=new OnlineEdits(()=>String(++id).padStart(20,'0'));state.observe({revision,issue});
  state.edit(row(),'want_fulltext','first page');state.observe({revision,issue});state.edit(row('51'),'reviewed_no_fulltext','second page');
  const request=state.request('complete');assert.equal(request.body.changes.length,2);assert.notEqual(request.body.operation_id,request.body.review_operation_id);
  assert.equal(state.request(),request);assert.throws(()=>state.edit(row(),'unreviewed','changed'),/pending/);
  assert.throws(()=>state.acknowledge({saved:false}));assert.equal(state.pending,request);
  state.acknowledge({saved:true});assert.equal(state.dirty,false);
});
test('online drafts reject metadata drift, excessive batches and reopening with edits; reset discards pending state',()=>{
  const state=new OnlineEdits();state.observe({revision,issue});state.edit(row(),'want_fulltext','kept');
  assert.throws(()=>state.observe({revision:'b'.repeat(64),issue}),/metadata_changed/);
  assert.throws(()=>state.request('reopen'),/save_before_reopen/);
  for(let n=2;n<=101;n++)state.edit(row(String(n)),'want_fulltext','kept');assert.throws(()=>state.request(),/too_many/);
  state.reset();assert.equal(state.dirty,false);assert.equal(state.pending,null);assert.equal(state.issue,null);
});
test('legacy review states and note-only edits retain versions; reverting edits creates no write',()=>{
  const state=new OnlineEdits();state.observe({revision,issue});const old={pmid:'1',review:{version:17,status:'read',note:'old'}};
  state.edit(old,'read','new');assert.deepEqual(state.request().body.changes,[{pmid:'1',status:'read',note:'new',expected_version:17}]);
  state.reset();state.observe({revision,issue});state.edit(old,'read','new');state.edit(old,'read','old');assert.equal(state.request(),null);
});
test('completion count includes unseen pages and changes back to unreviewed',()=>{
  const state=new OnlineEdits();state.observe({revision,issue:{...issue,unreviewed:2}});
  state.edit(row(),'want_fulltext','');assert.equal(state.unreviewedAfterEdits,1);
  state.edit(row('51'),'reviewed_no_fulltext','');assert.equal(state.unreviewedAfterEdits,0);
  state.edit(row(),'unreviewed','');assert.equal(state.unreviewedAfterEdits,1);
});
test('public online shell exposes only Firebase Web fields; Google owner API and sync protection remain required',async t=>{
  const f=await identityFixture({extractable:true}),cert=await certificate(f.owner.privateKey),origin='https://pmid-ledger-test.synthetic.workers.dev';
  const firebase={apiKey:'AIza'+'x'.repeat(35),authDomain:f.fixture.config.projectId+'.firebaseapp.com',projectId:f.fixture.config.projectId,appId:'1:123:web:abc123'};
  const assets=await onlineAssets(firebase),rt=await runtime({cloudTest:{onlineAssets:assets,bindings:{LEDGER_TEST_ONLY:'synthetic',LEDGER_ORIGIN:origin,LEDGER_SYNC_ENABLED:'0',LEDGER_IDENTITY:JSON.stringify({projectId:firebase.projectId,ownerUid:f.fixture.config.ownerUid})},keyResponses:()=>Response.json({[f.ownerJwk.kid]:cert},{headers:{'Cache-Control':'max-age=60'}})}});t.after(()=>rt.mf.dispose());await seedDatabase(rt.db);
  const page=await rt.mf.dispatchFetch(origin+'/api/app/');assert.equal(page.status,200);assert.match(await page.text(),/直近2か月/);assert.match(page.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);assert.equal(page.headers.get('Cache-Control'),'no-store');
  const config=await (await rt.mf.dispatchFetch(origin+'/api/app/config.json')).json();assert.deepEqual(config,{firebase});assert(!JSON.stringify(assets).includes(f.fixture.config.ownerUid));
  assert.equal((await rt.mf.dispatchFetch(origin+'/api/app/unknown')).status,404);
  assert.equal((await rt.mf.dispatchFetch(origin+'/api/app/',{headers:{Origin:'https://evil.invalid'}})).status,403);
  assert.equal((await rt.mf.dispatchFetch(origin+'/api/listIssues',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  const n=Math.floor(Date.now()/1000),jwt=await f.ownerToken({iat:n-1,exp:n+300,auth_time:n-10});
  const result=await rt.mf.dispatchFetch(origin+'/api/listIssues',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt},body:JSON.stringify({scope:'month',month:'2026-08'})});assert.equal(result.status,200);assert.equal((await result.json()).value.total,3);
  const code=assets['app.mjs'];assert(!/localStorage|sessionStorage|indexedDB|serviceWorker/.test(code));assert.match(code,/inMemoryPersistence/);
});
