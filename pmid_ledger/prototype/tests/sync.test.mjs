import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {runtime,fixture,call,seed} from '../runtime.mjs';
import {exportBackup} from '../backup-data.mjs';
const exec=promisify(execFile),root=fileURLToPath(new URL('../../../',import.meta.url));
async function python(url,...args){
  try{const r=await exec('python3',['-m','pmid_ledger.prototype.sync_local','--base-url',url,...args],{cwd:root,timeout:20000});return {code:0,...JSON.parse(r.stdout)};}
  catch(e){if(e.stdout)return {code:e.code,...JSON.parse(e.stdout)};throw e;}
}
async function setup(t){const rt=await runtime();t.after(()=>rt.mf.dispose());return rt;}
async function proxy(t,mf,intercept){
  const server=http.createServer(async(req,res)=>{
    try{let body='';for await(const chunk of req)body+=chunk;
      const response=await mf.dispatchFetch('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,body});
      const raw=await response.text(),override=await intercept(req.url,JSON.parse(body),response.status);
      res.writeHead(override??response.status,{'Content-Type':'application/json'});res.end(override?'{}':raw);
    }catch{res.writeHead(500);res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return `http://127.0.0.1:${server.address().port}`;
}

test('Python HTTP sync publishes, verifies, skips unchanged input and never rewrites review state',async t=>{
  const {mf,db}=await setup(t),url=String(await mf.ready);
  const first=await python(url);assert.equal(first.code,0);assert.equal(first.changed,true);assert.equal(first.verified,true);
  const loaded=(await call(mf,'listIssuePapers',{issue_key:'["synthetic-small","感染症"]'})).value;
  await call(mf,'saveAndCompleteIssue',{operation_id:crypto.randomUUID(),review_operation_id:crypto.randomUUID(),
    issue_key:loaded.issue.issue_key,revision:loaded.revision,expected_version:0,content_version:loaded.issue.content_version,
    changes:[{pmid:'1',expected_version:0,status:'want_fulltext',note:'keep synthetic note'}]});
  const before=(await exportBackup(db)).payload.tables;
  const unchanged=await python(url);assert.equal(unchanged.changed,false);assert.equal(unchanged.requests,1);
  const revised=await python(url,'--revised');assert.equal(revised.code,0);assert.equal(revised.changed,true);
  const after=(await exportBackup(db)).payload.tables;
  for(const name of ['review_events','review_current','issue_events','issue_current','operations','operation_ids'])assert.deepEqual(after[name],before[name]);
  assert.equal((await call(mf,'listIssuePapers',{issue_key:loaded.issue.issue_key})).value.issue.content_changed,true);
  assert.equal((await python(url,'--revised')).changed,false);
});

test('Python interrupted staging remains invisible and resumes without duplicate generations',async t=>{
  const {mf,db}=await setup(t),url=String(await mf.ready);
  assert.equal((await python(url,'--stop-after-stage')).published,false);
  assert.equal((await call(mf,'status',{}, {sync:true})).value.revision,null);
  assert.equal((await python(url)).code,0);
  assert.equal((await db.prepare('SELECT count(*) n FROM generations').first()).n,1);
});

test('Python retries identical publication after a committed response is lost',async t=>{
  const {mf,db}=await setup(t),requests=[];
  const url=await proxy(t,mf,async(path,body,status)=>{if(path==='/sync/publish'){requests.push(body);if(requests.length===1){assert.equal(status,200);return 503;}}});
  assert.equal((await python(url)).code,0);assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
  assert.equal((await db.prepare('SELECT count(*) n FROM generations').first()).n,1);
});

test('Python metadata conflict does not adopt a newer expected version or overwrite it',async t=>{
  const {mf}=await setup(t);await seed(mf);const base=(await call(mf,'status',{}, {sync:true})).value.revision;
  let injected=false,publishes=0;
  const url=await proxy(t,mf,async(path)=>{
    if(path==='/sync/stage'&&!injected){injected=true;const other=fixture();other.generation='f'.repeat(64);other.tables.Papers[1][1]='other synthetic source';await seed(mf,other,base);}
    if(path==='/sync/publish')publishes++;
  });
  const result=await python(url,'--revised');assert.equal(result.code,1);assert.equal(result.error,'sync_http_409');assert.equal(publishes,1);
  assert.equal((await call(mf,'status',{}, {sync:true})).value.revision,'f'.repeat(64));
});

test('Python transport will not follow a redirect to another endpoint',async t=>{
  const rt=await setup(t),location=String(await rt.mf.ready);let contacted=0;
  const server=http.createServer((req,res)=>{contacted++;res.writeHead(302,{Location:location});res.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await python(`http://127.0.0.1:${server.address().port}`);
  assert.equal(result.code,1);assert.equal(result.error,'sync_http_302');assert.equal(contacted,1);
});

test('opt-in profiles expose only counters and include D1 metadata without changing results',async t=>{
  const {mf}=await setup(t);await seed(mf);
  const plain=await call(mf,'listIssues'),profiled=await call(mf,'listIssues',{}, {profile:true});
  assert.deepEqual(profiled.value,plain.value);assert.equal(plain.profile,undefined);
  assert.equal(profiled.profile.statements,1);assert.equal(profiled.profile.missing_rows_metadata,0);
  assert(profiled.profile.rows_read>0);assert.equal(profiled.profile.rows_written,0);
  assert(Object.values(profiled.profile).every(v=>typeof v==='number'&&Number.isFinite(v)));
  const status=await call(mf,'status',{}, {sync:true,token:'Bearer local-synthetic-owner'});assert.equal(status.status,403);
});

test('saved-operation lookups do not scan a thousand previous review events',async t=>{
  const {mf}=await setup(t);await seed(mf);
  const revision=(await call(mf,'status',{}, {sync:true})).value.revision;
  for(let version=0;version<10;version++){
    const changes=Array.from({length:100},(_,i)=>({pmid:String(i+1),expected_version:version,status:'want_fulltext',note:'synthetic history'}));
    assert.equal((await call(mf,'saveReviews',{operation_id:crypto.randomUUID(),revision,changes})).status,200);
  }
  const result=await call(mf,'saveReviews',{operation_id:crypto.randomUUID(),revision,
    changes:[{pmid:'1',expected_version:10,status:'want_fulltext',note:'latest synthetic note'}]}, {profile:true});
  assert.equal(result.status,200);assert(result.profile.rows_read<200);
  assert.equal(result.value.reviews[0].review.version,11);
});

test('metadata size is checked in UTF-8 bytes and rejects unsafe rows before any insert',async t=>{
  const {mf,db}=await setup(t),data=fixture();
  data.tables.Papers[1][1]='a'.repeat(1800000);
  assert(Buffer.byteLength(JSON.stringify(data))<2000000);
  const result=await call(mf,'stage',data,{sync:true});
  assert.equal(result.status,413);assert.equal(result.error,'metadata_requires_chunked_storage');
  data.tables.Papers[1][1]='🧪'.repeat(500000);
  const unicode=await call(mf,'stage',data,{sync:true});assert.equal(unicode.status,413);assert.equal(unicode.error,'request_too_large');
  assert.equal((await db.prepare('SELECT count(*) n FROM generations').first()).n,0);
});
