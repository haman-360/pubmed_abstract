import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalJWKSet,SignJWT,generateKeyPair,exportJWK} from 'jose';
import {createIdentityVerifier,verifyIdentityRequest} from '../identity.mjs';
import {runtime,seed,call} from '../runtime.mjs';
import {identityFixture,now,seconds} from './identity-fixture.mjs';
const f=await identityFixture();
const make=(options={})=>createIdentityVerifier(f.fixture.config,{ownerKeys:createLocalJWKSet(f.fixture.ownerJwks),syncKeys:createLocalJWKSet(f.fixture.syncJwks),now:()=>now,...options});

test('valid owner and sync JWTs verify; refreshed owner tokens can retain the earlier login time',async()=>{
  assert.deepEqual(await make().verify(await f.ownerToken(),'owner'),{role:'owner'});
  assert.deepEqual(await make().verify(await f.syncToken(),'sync'),{role:'sync'});
  const refreshed=await f.ownerToken({iat:seconds-1,auth_time:seconds-500,exp:seconds+600});
  assert.deepEqual(await make().verify(refreshed,'owner'),{role:'owner'});
  assert.throws(()=>createIdentityVerifier({...f.fixture.config,ownerUid:''},{ownerKeys:()=>{},syncKeys:()=>{}}));
});

test('other owners, projects, issuers, providers, missing claims and invalid times are denied',async()=>{
  const cases=[{sub:'another-uid'},{aud:'another-project'},{aud:[f.fixture.config.projectId]},
    {iss:'https://securetoken.google.com/another-project'},{exp:seconds},{exp:undefined},{iat:undefined},{auth_time:undefined},
    {iat:seconds+1},{auth_time:seconds+1},{auth_time:seconds-5},{iat:'123'},{exp:'123'},{auth_time:true},
    {firebase:{sign_in_provider:'password'}},{sub:''}];
  for(const changes of cases)await assert.rejects(()=>f.ownerToken(changes).then(token=>make().verify(token,'owner')));
});

test('forged signatures, unknown/missing key IDs, unsafe algorithms and token key URLs are denied',async()=>{
  const token=await f.ownerToken(),parts=token.split('.');
  parts[1]=Buffer.from(JSON.stringify({...f.ownerPayload,exp:seconds+600})).toString('base64url');
  await assert.rejects(()=>make().verify(parts.join('.'),'owner'));
  const other=await generateKeyPair('RS256');
  await assert.rejects(()=>f.sign(f.ownerPayload,other.privateKey,f.ownerJwk.kid).then(t=>make().verify(t,'owner')));
  for(const header of [{kid:'unknown'},{kid:undefined},{jku:'https://untrusted.invalid/keys'},{jwk:f.ownerJwk},{x5u:'https://untrusted.invalid/cert'}])
    await assert.rejects(()=>f.ownerToken({},header).then(t=>make().verify(t,'owner')));
  const hs=await new SignJWT(f.ownerPayload).setProtectedHeader({alg:'HS256',kid:f.ownerJwk.kid}).sign(new Uint8Array(32));
  await assert.rejects(()=>make().verify(hs,'owner'));
  const none=Buffer.from('{"alg":"none","kid":"synthetic-owner"}').toString('base64url')+'.'+token.split('.')[1]+'.';
  for(const bad of [none,'invalid','x'.repeat(16385)])await assert.rejects(()=>make().verify(bad,'owner'));
});

test('sync requires its exact issuer, audience and service identity; user Access tokens do not qualify',async()=>{
  for(const changes of [{iss:'https://another.cloudflareaccess.com'},{aud:['wrong']},{common_name:'another.access'},
    {sub:'human-user'},{type:'org'},{common_name:undefined},{type:undefined},{sub:undefined},{exp:seconds},{iat:seconds+1}])
    await assert.rejects(()=>f.syncToken(changes).then(t=>make().verify(t,'sync')));
  const owner=await f.ownerToken(),sync=await f.syncToken();
  await assert.rejects(()=>make().verify(owner,'sync'));await assert.rejects(()=>make().verify(sync,'owner'));
});

test('key rotation can accept configured old/new keys; missing keys and provider failures fail closed',async()=>{
  const rotated=await generateKeyPair('RS256'),jwk={...await exportJWK(rotated.publicKey),kid:'rotated',alg:'RS256',use:'sig'};
  const token=await f.sign(f.ownerPayload,rotated.privateKey,jwk.kid);
  await assert.rejects(()=>make().verify(token,'owner'));
  const both=make({ownerKeys:createLocalJWKSet({keys:[f.ownerJwk,jwk]})});
  assert.deepEqual(await both.verify(token,'owner'),{role:'owner'});assert.deepEqual(await both.verify(await f.ownerToken(),'owner'),{role:'owner'});
  await assert.rejects(()=>make({ownerKeys:async()=>{throw new Error('synthetic provider unavailable');}}).verify(token,'owner'));
  const later=make({now:()=>new Date(now.getTime()+3600000)});await assert.rejects(()=>later.verify(token,'owner'));
});

const small='["synthetic-small","感染症"]';
test('workerd verifies JWTs before all DB routes; rejected saves leave data intact and roles cannot cross',async t=>{
  const rt=await runtime({identityFixture:f.fixture,now:now.toISOString()});t.after(()=>rt.mf.dispose());
  const owner=await f.ownerToken(),sync=await f.syncToken();await seed(rt.mf,undefined,null,{accessToken:sync});
  const loaded=await call(rt.mf,'listIssuePapers',{issue_key:small},{token:'Bearer '+owner});assert.equal(loaded.status,200);
  const operation={operation_id:crypto.randomUUID(),revision:loaded.value.revision,changes:[{pmid:'1',expected_version:0,status:'want_fulltext',note:'synthetic protected save'}]};
  for(const options of [{token:''},{token:'Bearer local-synthetic-owner'},{token:'Bearer '+await f.ownerToken({sub:'another-uid'})},{token:'Bearer '+await f.ownerToken({}, {kid:'unknown'})},
    {token:'Bearer '+await f.ownerToken({exp:seconds})},{token:'Bearer '+sync},{accessToken:sync}]){
    assert.equal((await call(rt.mf,'saveReviews',operation,options)).status,403);
    assert.equal((await rt.db.prepare('SELECT count(*) n FROM operations').first()).n,0);
  }
  assert.equal((await call(rt.mf,'status',{}, {sync:true,token:'Bearer '+owner})).status,403);
  assert.equal((await call(rt.mf,'status',{}, {sync:true,accessToken:owner})).status,403);
  assert.equal((await call(rt.mf,'status',{}, {sync:true,token:'Bearer local-synthetic-sync'})).status,403);
  assert.equal((await call(rt.mf,'saveReviews',operation,{token:'Bearer '+owner,fault:'rollback'})).status,200);
  assert.equal((await call(rt.mf,'saveReviews',operation,{token:'Bearer '+owner})).value.replayed,true);
  assert.equal((await rt.db.prepare('SELECT count(*) n FROM operations').first()).n,1);
  assert.equal((await call(rt.mf,'listIssuePapers',{issue_key:small},{token:'Bearer '+owner})).value.items[0].review.note,'synthetic protected save');
  const invalid=await call(rt.mf,'backup',{}, {token:'Bearer '+await f.ownerToken({sub:'other'})});assert.deepEqual(invalid,{status:403,error:'identity_denied'});
  assert.equal((await rt.mf.dispatchFetch('https://outside.invalid/api/listIssues',{method:'POST',headers:{Authorization:'Bearer '+owner}})).status,403);
});

test('no identity failure or ambiguous header reaches the database; private key configuration is refused',async()=>{
  const {default:worker}=await import('../identity-worker.mjs');let touches=0;
  const DB={prepare(){touches++;throw new Error('database must not be touched');}};
  const env={LOCAL_PROTOTYPE:'1',LOCAL_IDENTITY_FIXTURE:JSON.stringify(f.fixture),LOCAL_NOW:now.toISOString(),DB};
  const token=await f.ownerToken();
  for(const headers of [{},{Authorization:'Bearer local-synthetic-owner'},{Authorization:'Bearer '+token,'Cf-Access-Jwt-Assertion':await f.syncToken()},
    {'CF-Access-Client-Id':'synthetic-sync.access','CF-Access-Client-Secret':'synthetic-not-a-real-secret'}]){
    for(const path of ['/api/listIssues','/api/getPaperDetail','/api/backupPage','/api/saveAndCompleteIssue','/sync/status','/sync/publish']){
      const r=await worker.fetch(new Request('http://127.0.0.1'+path,{method:'POST',headers}),env);assert.equal(r.status,403);
    }
  }
  const broken=structuredClone(f.fixture);broken.ownerJwks.keys[0].d='invalid-private-material';
  assert.equal((await worker.fetch(new Request('http://127.0.0.1/api/listIssues',{method:'POST'}),{...env,LOCAL_IDENTITY_FIXTURE:JSON.stringify(broken)})).status,503);
  assert.equal(touches,0);
  const request=new Request('http://127.0.0.1/sync/status',{headers:{Authorization:'Bearer '+token}});
  await assert.rejects(()=>verifyIdentityRequest(request,make()));
});
