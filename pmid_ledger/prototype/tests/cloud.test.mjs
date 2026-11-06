import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {runtime,seed,seedDatabase} from '../runtime.mjs';
import cloud from '../cloud-worker.mjs';
import {identityFixture,certificate} from './identity-fixture.mjs';
import {FIREBASE_CERTS} from '../identity-keys.mjs';
const f=await identityFixture({extractable:true}),cert=await certificate(f.owner.privateKey);
const origin='https://pmid-ledger-test.synthetic.workers.dev';
const reply=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Cache-Control':'max-age=60'}});
const dates=()=>{const n=Math.floor(Date.now()/1000);return {iat:n-10,auth_time:n-20,exp:n+300};};
const owner=changes=>f.ownerToken({...dates(),...changes}),sync=changes=>f.syncToken({...dates(),...changes});
async function setup(t,{enabled=true,diagnostics=false,bindings={}}={}){
  const keys=[];
  const rt=await runtime({cloudTest:{bindings:{LEDGER_TEST_ONLY:'synthetic',LEDGER_ORIGIN:origin,
    LEDGER_IDENTITY:JSON.stringify(f.fixture.config),LEDGER_SYNC_ENABLED:enabled?'1':'0',
    LEDGER_TEST_DIAGNOSTICS:diagnostics?'1':'0',...bindings},accessIssuer:f.fixture.config.accessIssuer,keyResponses:request=>{
      keys.push(request.url);assert.equal(request.headers.get('Authorization'),null);
      assert.equal(request.headers.get('Cf-Access-Client-Secret'),null);
      return reply(request.url===FIREBASE_CERTS?{[f.ownerJwk.kid]:cert}:f.fixture.syncJwks);
    }}});
  t.after(()=>rt.mf.dispose());return {...rt,keys};
}
async function call(mf,path,body={},headers={},url=origin){
  const response=await mf.dispatchFetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  return {status:response.status,...await response.json()};
}

test('cloud bundle excludes mock entrypoints, fixed tokens, fixtures and fault headers',async()=>{
  const result=await build({entryPoints:[new URL('../cloud-worker.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',metafile:true});
  assert(!Object.keys(result.metafile.inputs).some(p=>/(?:^|\/)(worker|identity-worker|login-worker|runtime)\.mjs$/.test(p)));
  assert(!/local-synthetic-(owner|sync)|LOCAL_IDENTITY_FIXTURE|X-Local-Fault|LOCAL_NOW|local_response_lost_retry_same_request|drop-response/.test(result.outputFiles[0].text));
});

test('missing or invalid cloud configuration refuses requests without D1 calls',async()=>{
  let calls=0;const DB={prepare:()=>{calls++;throw new Error('must not touch DB');}};
  const base={DB,LEDGER_TEST_ONLY:'synthetic',LEDGER_ORIGIN:origin,LEDGER_IDENTITY:JSON.stringify(f.fixture.config)};
  for(const change of [{LEDGER_TEST_ONLY:undefined},{LEDGER_ORIGIN:'http://127.0.0.1'},
    {LEDGER_ORIGIN:'https://existing-pages.example.com'},{LEDGER_IDENTITY:'{}'},
    {LEDGER_IDENTITY:JSON.stringify({...f.fixture.config,ownerUid:null})},{LEDGER_SYNC_ENABLED:'invalid'},
    {LEDGER_SYNC_ENABLED:'1',LEDGER_IDENTITY:JSON.stringify({projectId:f.fixture.config.projectId,ownerUid:f.fixture.config.ownerUid})}]){
    const response=await cloud.fetch(new Request(origin+'/api/listIssues',{method:'POST'}),{...base,...change});assert.equal(response.status,503);
  }
  assert.equal(calls,0);
});

test('cloud denies fake credentials, wrong UID, expired tokens and cross-role reuse before any writes',async t=>{
  const {mf,db}=await setup(t);const valid=await owner(),service=await sync();
  for(const [path,headers]of [
    ['/api/listIssues',{}],['/api/listIssues',{Authorization:'Bearer local-synthetic-owner'}],
    ['/api/listIssues',{Authorization:'Bearer '+await owner({sub:'someone-else'})}],
    ['/api/listIssues',{Authorization:'Bearer '+await owner({exp:Math.floor(Date.now()/1000)-1})}],
    ['/api/saveReviews',{'Cf-Access-Jwt-Assertion':service}],['/sync/begin',{Authorization:'Bearer '+valid}],
    ['/sync/begin',{'CF-Access-Client-Id':'synthetic-sync.access','CF-Access-Client-Secret':'synthetic-not-an-assertion'}],
    ['/api/listIssues',{Authorization:'Bearer '+valid,'Cf-Access-Jwt-Assertion':service}],
    ['/identity/probe',{Authorization:'Bearer '+valid}],
    ['/api/wantedPmids',{}],['/api/wantedPmids',{'Cf-Access-Jwt-Assertion':service}],
    ['/sync/queueState',{Authorization:'Bearer '+valid}]]){
    assert.equal((await call(mf,path,{},headers)).status,403);
  }
  for(const table of ['generations','operations','review_events','issue_events'])assert.equal((await db.prepare('SELECT count(*) n FROM '+table).first()).n,0);
});

test('owner-only TEST works with Access unconfigured; fault and local diagnostic headers have no effect',async t=>{
  const config={projectId:f.fixture.config.projectId,ownerUid:f.fixture.config.ownerUid};
  const {mf,db,keys}=await setup(t,{enabled:false,bindings:{LEDGER_IDENTITY:JSON.stringify(config)}});await seedDatabase(db);
  const authorization={Authorization:'Bearer '+await owner(),'X-Local-Fault':'read-limit','X-Local-Profile':'1'};
  const read=await call(mf,'/api/listIssues',{scope:'all'},authorization);assert.equal(read.status,200);assert.equal(read.value.items.length,6);assert(!read.profile);
  const body={operation_id:crypto.randomUUID(),revision:read.value.revision,changes:[{pmid:'1',expected_version:0,status:'want_fulltext',note:'synthetic cloud test'}]};
  const save=await call(mf,'/api/saveReviews',body,{...authorization,'X-Local-Fault':'rollback'});assert.equal(save.status,200);assert.equal(save.value.saved,true);
  const again=await call(mf,'/api/saveReviews',body,{...authorization,'X-Local-Fault':'drop-response'});assert.equal(again.status,200);assert.equal(again.value.replayed,true);
  assert.equal((await db.prepare('SELECT count(*) n FROM review_events').first()).n,1);
  assert.equal((await call(mf,'/sync/status',{}, {'Cf-Access-Jwt-Assertion':await sync()})).status,403);
  assert.deepEqual(keys,[FIREBASE_CERTS]);
});

test('signed Access TEST sync publishes chunks; owner saves survive later metadata sync',async t=>{
  const {mf,db}=await setup(t,{diagnostics:true}),service=await sync(),authorization={Authorization:'Bearer '+await owner()};
  const remote={dispatchFetch:(url,options)=>mf.dispatchFetch(origin+new URL(url).pathname,options)};
  await seed(remote,undefined,null,{accessToken:service});
  const read=await call(mf,'/api/listIssues',{scope:'all'},authorization);assert.equal(read.status,200);
  assert(read.profile.database_calls>0);assert(read.profile.rows_read>0);assert(!('cpu_ms'in read.profile));
  const body={operation_id:crypto.randomUUID(),revision:read.value.revision,changes:[{pmid:'1',expected_version:0,status:'want_fulltext',note:'keep synthetic review'}]};
  assert.equal((await call(mf,'/api/saveReviews',body,authorization)).status,200);
  const {fixture}=await import('../runtime.mjs');await seed(remote,fixture(true),read.value.revision,{accessToken:service});
  assert.equal((await db.prepare('SELECT note FROM review_current WHERE pmid=?').bind('1').first()).note,'keep synthetic review');
  assert.equal((await db.prepare('SELECT count(*) n FROM review_events').first()).n,1);
});

test('cloud rejects other origins, query credentials, non-JSON requests and unbounded bodies',async t=>{
  const {mf,db}=await setup(t),authorization={Authorization:'Bearer '+await owner()};
  for(const [url,method,headers,body,status]of [
    [origin+'/api/listIssues','POST',{Origin:'https://evil.invalid'},'{}',403],
    [origin+'/api/listIssues','POST',{Origin:'null'},'{}',403],
    [origin+'/api/listIssues?token=forbidden','POST',{},'{}',403],
    ['https://pmid-ledger-test.other.workers.dev/api/listIssues','POST',{},'{}',403],
    [origin+'/api/listIssues','GET',{},undefined,405],
    [origin+'/api/listIssues','POST',{'Content-Type':'text/plain'},'{}',415],
    [origin+'/api/listIssues','POST',{},'null',400],
    [origin+'/api/listIssues','POST',{},'[]',400],
    [origin+'/api/listIssues','POST',{},'{bad',400],
    [origin+'/api/listIssues','POST',{},JSON.stringify({padding:'x'.repeat(2000000)}),413]]){
    const response=await mf.dispatchFetch(url,{method,headers:{'Content-Type':'application/json',...authorization,...headers},...(body?{body}:{})});
    assert.equal(response.status,status,JSON.stringify({url,method,headers,bodyLength:body?.length}));assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
  }
  // Miniflare's HTTP bridge removes empty headers; test an explicitly empty Origin directly.
  const empty=await cloud.fetch(new Request(origin+'/api/listIssues',{method:'POST',headers:{Origin:''}}),
    {DB:db,LEDGER_TEST_ONLY:'synthetic',LEDGER_ORIGIN:origin,LEDGER_IDENTITY:JSON.stringify(f.fixture.config)});
  assert.equal(empty.status,403);
  assert.equal((await db.prepare('SELECT count(*) n FROM operations').first()).n,0);
});

test('D1 daily limit response retains 24-hour retry advice without a public fault switch',async t=>{
  // A failing binding and intercepted public certificate stand in for external services.
  t.mock.method(globalThis,'fetch',async()=>reply({[f.ownerJwk.kid]:cert}));
  let calls=0;const DB={prepare:()=>{calls++;throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.");}};
  const response=await cloud.fetch(new Request(origin+'/api/listIssues',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await owner()},body:'{}'}),
    {DB,LEDGER_TEST_ONLY:'synthetic',LEDGER_ORIGIN:origin,LEDGER_IDENTITY:JSON.stringify({...f.fixture.config,testCacheKey:'quota'})});
  assert.equal(response.status,429);assert.equal(calls,1);assert.equal(response.headers.get('Retry-After'),'86400');
  assert.equal((await response.json()).retry_after_seconds,86400);
});
