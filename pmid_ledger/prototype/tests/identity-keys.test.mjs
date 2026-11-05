import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {exportPKCS8,generateKeyPair} from 'jose';
import {createPublicKeySources,FIREBASE_CERTS} from '../identity-keys.mjs';
import {createIdentityVerifier} from '../identity.mjs';
import {runtime,seed,call} from '../runtime.mjs';
import {identityFixture,now} from './identity-fixture.mjs';
const f=await identityFixture({extractable:true});
async function certificate(key){
  const pem=await exportPKCS8(key);
  return new Promise((resolve,reject)=>{
    // The test-only private key travels via stdin, never argv or a temporary file.
    const child=spawn('/usr/bin/openssl',['req','-new','-x509','-key','/dev/stdin','-subj','/CN=synthetic-identity-test','-days','2'],{stdio:['pipe','pipe','ignore']});
    const output=[];child.stdout.on('data',b=>output.push(b));child.on('error',reject);
    child.on('close',code=>code===0?resolve(Buffer.concat(output).toString('utf8')):reject(new Error('synthetic certificate generation failed')));
    child.stdin.end(pem);
  });
}
const cert=await certificate(f.owner.privateKey);
const reply=(data,policy='public, max-age=60',age=0)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Cache-Control':policy,Age:String(age)}});
const ownerData={[f.ownerJwk.kid]:cert};
const verifier=sources=>createIdentityVerifier(f.fixture.config,{...sources,now:()=>now});

test('official Firebase X509 and configured Access JWKS verify signed tokens without transmitting them',async()=>{
  const urls=[];
  const sources=createPublicKeySources(f.fixture.config,{fetcher:async(url,options)=>{
    urls.push(url);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert(options.signal);assert.equal(options.headers,undefined);
    return url===FIREBASE_CERTS?reply(ownerData):reply(f.fixture.syncJwks);
  }});
  assert.deepEqual(await verifier(sources).verify(await f.ownerToken(),'owner'),{role:'owner'});
  assert.deepEqual(await verifier(sources).verify(await f.syncToken(),'sync'),{role:'sync'});
  assert.deepEqual(urls,[FIREBASE_CERTS,f.fixture.config.accessIssuer+'/cdn-cgi/access/certs']);
  assert.throws(()=>createPublicKeySources({...f.fixture.config,accessIssuer:'https://team.cloudflareaccess.com.evil.invalid'},{fetcher:()=>{throw new Error('must not fetch');}}));
});

test('public cache honors max-age minus Age and combines concurrent refreshes',async()=>{
  let clock=100000,calls=0;
  const v=verifier(createPublicKeySources(f.fixture.config,{now:()=>clock,fetcher:async()=>{calls++;await Promise.resolve();return reply(ownerData,'max-age=60',10);}}));
  const token=await f.ownerToken();await Promise.all(Array.from({length:10},()=>v.verify(token,'owner')));assert.equal(calls,1);
  clock+=49999;await v.verify(token,'owner');assert.equal(calls,1);
  clock++;await v.verify(token,'owner');assert.equal(calls,2);
});

test('unknown kid refreshes at most once in a fresh cache cooldown; rotated certificates replace old keys',async()=>{
  const pair=await generateKeyPair('RS256',{extractable:true}),rotated=await certificate(pair.privateKey);
  const token=await f.sign(f.ownerPayload,pair.privateKey,'rotated');let clock=100000,calls=0,data=ownerData;
  const v=verifier(createPublicKeySources(f.fixture.config,{now:()=>clock,fetcher:async()=>{calls++;return reply(data);}}));
  await v.verify(await f.ownerToken(),'owner');
  for(let i=0;i<5;i++)await assert.rejects(()=>v.verify(token,'owner'));assert.equal(calls,1);
  clock+=30000;data={...ownerData,rotated};await v.verify(token,'owner');assert.equal(calls,2);
  await v.verify(await f.ownerToken(),'owner');assert.equal(calls,2);
  clock+=60000;data={rotated};await v.verify(token,'owner');assert.equal(calls,3);
  const old=await f.ownerToken();await assert.rejects(()=>v.verify(old,'owner'));assert.equal(calls,3);
});

test('expired keys do not authorize requests when refresh fails; bad HTTP, JSON, certificates and oversized responses fail closed',async()=>{
  let clock=100000,fail=false;
  const v=verifier(createPublicKeySources(f.fixture.config,{now:()=>clock,fetcher:async()=>fail?new Response('',{status:503}):reply(ownerData,'max-age=1')}));
  const token=await f.ownerToken();await v.verify(token,'owner');clock+=1000;fail=true;await assert.rejects(()=>v.verify(token,'owner'));
  for(const response of [new Response('',{status:302}),new Response('{bad',{headers:{'Content-Type':'application/json'}}),reply({bad:'not a certificate'}),
    new Response(JSON.stringify(ownerData),{headers:{'Content-Type':'text/plain'}}),reply({padding:'x'.repeat(65536)}),
    new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'65537'}})]){
    const bad=verifier(createPublicKeySources(f.fixture.config,{fetcher:async()=>response}));await assert.rejects(()=>bad.verify(token,'owner'));
  }
  const down=verifier(createPublicKeySources(f.fixture.config,{fetcher:async()=>{throw new Error('synthetic network failure');}}));await assert.rejects(()=>down.verify(token,'owner'));
  const privateKeys={keys:[{...f.fixture.syncJwks.keys[0],d:'invalid-private-material'}]};
  const invalid=verifier(createPublicKeySources(f.fixture.config,{fetcher:async()=>reply(privateKeys)}));const sync=await f.syncToken();await assert.rejects(()=>invalid.verify(sync,'sync'));
});

test('no-store, no-cache and absent cache policy do not extend public key reuse',async()=>{
  for(const policy of ['no-store, max-age=60','no-cache="headers", max-age=60','']){
    let calls=0;const v=verifier(createPublicKeySources(f.fixture.config,{fetcher:async()=>{calls++;return reply(ownerData,policy);}}));
    const token=await f.ownerToken();await v.verify(token,'owner');await v.verify(token,'owner');assert.equal(calls,2);
  }
});

test('workerd fetches only intercepted public key responses and rejects a save if refresh is unavailable',async t=>{
  let unavailable=false;const urls=[];
  const rt=await runtime({identityFixture:{config:f.fixture.config,remoteKeys:true},now:now.toISOString(),identityKeyResponses:request=>{
    urls.push(request.url);assert.equal(request.headers.get('Authorization'),null);assert.equal(request.headers.get('Cf-Access-Jwt-Assertion'),null);
    return unavailable?new Response('',{status:503}):request.url===FIREBASE_CERTS?reply(ownerData,'max-age=0'):reply(f.fixture.syncJwks);
  }});t.after(()=>rt.mf.dispose());
  const sync=await f.syncToken(),owner=await f.ownerToken();await seed(rt.mf,undefined,null,{accessToken:sync});
  const read=await call(rt.mf,'listIssues',{}, {token:'Bearer '+owner});assert.equal(read.status,200);
  const request={operation_id:crypto.randomUUID(),revision:read.value.revision,changes:[{pmid:'1',expected_version:0,status:'want_fulltext',note:'synthetic external-key policy'}]};
  unavailable=true;assert.equal((await call(rt.mf,'saveReviews',request,{token:'Bearer '+owner})).status,403);
  assert.equal((await rt.db.prepare('SELECT count(*) n FROM operations').first()).n,0);
  unavailable=false;assert.equal((await call(rt.mf,'saveReviews',request,{token:'Bearer '+owner})).status,200);
  assert.equal((await rt.db.prepare('SELECT count(*) n FROM operations').first()).n,1);
  assert(urls.every(url=>[FIREBASE_CERTS,f.fixture.config.accessIssuer+'/cdn-cgi/access/certs'].includes(url)));
});

test('normal runtime still denies outbound access even with a remote-key test entry',async t=>{
  const rt=await runtime({identityFixture:{config:f.fixture.config,remoteKeys:true},now:now.toISOString()});t.after(()=>rt.mf.dispose());
  const r=await call(rt.mf,'status',{}, {sync:true,accessToken:await f.syncToken()});assert.deepEqual(r,{status:403,error:'identity_denied'});
  assert.equal((await rt.db.prepare('SELECT count(*) n FROM generations').first()).n,0);
});
