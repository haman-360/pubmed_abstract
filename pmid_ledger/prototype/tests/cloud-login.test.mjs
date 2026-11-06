import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime,seedDatabase,call} from '../runtime.mjs';
import {identityFixture,certificate} from './identity-fixture.mjs';
import {CLOUD_TEST_ISSUE as ISSUE,CLOUD_TEST_NOTE as NOTE,validateCloudOrigin} from '../cloud-login-proxy.mjs';
const f=await identityFixture({extractable:true}),cert=await certificate(f.owner.privateKey);
const ORIGIN='https://pmid-ledger-test.synthetic.workers.dev';
const firebase={apiKey:'AIza'+'x'.repeat(35),authDomain:f.fixture.config.projectId+'.firebaseapp.com',projectId:f.fixture.config.projectId,appId:'1:123:web:abc123'};
const settings={firebase,ownerUid:f.fixture.config.ownerUid};
const keys=()=>Response.json({[f.ownerJwk.kid]:cert},{headers:{'Cache-Control':'max-age=60'}});
const token=changes=>{const n=Math.floor(Date.now()/1000);return f.ownerToken({iat:n-10,exp:n+300,...changes});};
async function setup(t,{cloudFetch}={}){
  const cloud=await runtime({cloudTest:{bindings:{LEDGER_TEST_ONLY:'synthetic',LEDGER_ORIGIN:ORIGIN,LEDGER_SYNC_ENABLED:'0',LEDGER_TEST_DIAGNOSTICS:'1',LEDGER_IDENTITY:JSON.stringify({projectId:firebase.projectId,ownerUid:settings.ownerUid})},keyResponses:keys}});
  t.after(()=>cloud.mf.dispose());await seedDatabase(cloud.db);
  const forwarded=[];
  const local=await runtime({ownerLogin:{settings:()=>settings,keyResponses:keys,cloudOrigin:ORIGIN,cloudFetch:async request=>{
    forwarded.push({url:request.url,authorization:request.headers.get('Authorization'),origin:request.headers.get('Origin'),access:request.headers.get('Cf-Access-Jwt-Assertion')});
    return cloudFetch?cloudFetch(request):cloud.mf.dispatchFetch(request);
  }}});t.after(()=>local.mf.dispose());return {local,cloud,forwarded};
}
test('Google owner proxy writes only the fixed TEST paper and replays without a local DB operation',async t=>{
  const {local,cloud,forwarded}=await setup(t),owner='Bearer '+await token();
  const listed=await call(local.mf,'listIssuePapers',{issue_key:ISSUE},{token:owner});assert.equal(listed.status,200);assert.equal(listed.value.total,1);
  const body={operation_id:crypto.randomUUID(),revision:listed.value.revision,changes:[{pmid:'1',expected_version:0,status:'want_fulltext',note:NOTE}]};
  const first=await call(local.mf,'saveReviews',body,{token:owner});assert.equal(first.status,200);assert.equal(first.value.replayed,false);
  assert.equal((await call(local.mf,'saveReviews',body,{token:owner})).value.replayed,true);
  const after=await call(local.mf,'listIssuePapers',{issue_key:ISSUE},{token:owner});assert.equal(after.value.items[0].review.version,1);assert.equal(after.value.items[0].review.note,NOTE);
  assert.equal((await call(local.mf,'getPaperDetail',{pmid:'1',issue_key:ISSUE},{token:owner})).status,200);
  assert.equal((await cloud.db.prepare('SELECT count(*) n FROM operations').first()).n,1);
  assert.equal((await cloud.db.prepare('SELECT count(*) n FROM review_events').first()).n,1);
  assert.equal((await local.db.prepare('SELECT count(*) n FROM operations').first()).n,0);
  assert(forwarded.every(r=>r.url.startsWith(ORIGIN+'/api/')&&r.authorization===owner&&r.origin===null&&r.access===null));
});
test('other users, sync, different papers/notes, bad origins and large bodies never reach TEST',async t=>{
  const {local,forwarded}=await setup(t),owner='Bearer '+await token();
  for(const options of [{token:'Bearer '+await token({sub:'other-uid'})},{token:owner,origin:'https://untrusted.invalid'},{}])assert.equal((await call(local.mf,'listIssues',{scope:'all'},options)).status,403);
  assert.equal(forwarded.length,0);
  for(const [name,body]of [['listIssues',{scope:'recent'}],['listIssuePapers',{issue_key:'["other","感染症"]'}],['getPaperDetail',{pmid:'2',issue_key:ISSUE}],['backupStart',{}],['saveReviews',{changes:null,operation_id:crypto.randomUUID(),revision:'a'.repeat(64)}]])assert.equal((await call(local.mf,name,body,{token:owner})).status,403);
  assert.equal((await call(local.mf,'saveReviews',{x:'x'.repeat(9000)},{token:owner})).status,413);
  assert.equal((await call(local.mf,'status',{}, {sync:true,token:owner})).status,403);
  assert.equal(forwarded.length,0);
  for(const origin of ['https://existing.pages.dev',ORIGIN+'/path','http://127.0.0.1:8787',ORIGIN+'?x=y'])assert.throws(()=>validateCloudOrigin(origin));
});
test('cloud redirects are not followed; API tokens and enrollment are not exposed by the page',async t=>{
  const {local,forwarded}=await setup(t,{cloudFetch:()=>new Response('',{status:302,headers:{Location:'https://untrusted.invalid/'}})});
  const result=await call(local.mf,'listIssues',{scope:'all'},{token:'Bearer '+await token()});assert.equal(result.status,502);assert.equal(result.error,'cloud_redirect_denied');assert.equal(forwarded.length,1);
  const page=await (await local.mf.dispatchFetch('http://localhost/')).text();assert.match(page,/クラウドTEST/);assert(!page.includes(settings.ownerUid));
  const config=await (await local.mf.dispatchFetch('http://localhost/login-config')).json();assert.deepEqual(config,{firebase});
  assert.equal((await local.mf.dispatchFetch('http://localhost/identity/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
});
