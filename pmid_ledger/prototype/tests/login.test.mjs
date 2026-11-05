import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runtime,seedDatabase,call} from '../runtime.mjs';
import {readLoginSettings,pinOwner,validateLoginSettings} from '../login-settings.mjs';
import {identityFixture,now,certificate} from './identity-fixture.mjs';
const f=await identityFixture({extractable:true}),cert=await certificate(f.owner.privateKey);
const firebase={apiKey:'AIza'+'x'.repeat(35),authDomain:f.fixture.config.projectId+'.firebaseapp.com',projectId:f.fixture.config.projectId,appId:'1:123:web:abc123'};
const keyResponses=()=>new Response(JSON.stringify({[f.ownerJwk.kid]:cert}),{headers:{'Content-Type':'application/json','Cache-Control':'max-age=60'}});

test('local Web config ignores analytics/storage fields and UID pinning is a local file operation',async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'pmid-login-config-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const file=join(directory,'web.json');
  await fs.writeFile(file,JSON.stringify({firebase:{...firebase,measurementId:'not-loaded'},ownerUid:null}),{mode:0o600});
  assert.equal((await readLoginSettings(file)).firebase.measurementId,undefined);
  await pinOwner(file,'verified-synthetic-uid');assert.equal((await readLoginSettings(file)).ownerUid,'verified-synthetic-uid');assert.equal((await fs.stat(file)).mode&0o777,0o600);
  await assert.rejects(()=>pinOwner(file,''));assert.equal((await readLoginSettings(file)).ownerUid,'verified-synthetic-uid');
  assert.throws(()=>validateLoginSettings({firebase:{...firebase,authDomain:'untrusted.invalid'}}));
});

test('verified login probe does not enroll the first user or grant access; explicitly pinned UID can read and save',async t=>{
  const settings={firebase,ownerUid:null};const rt=await runtime({now:now.toISOString(),ownerLogin:{settings:()=>settings,keyResponses}});t.after(()=>rt.mf.dispose());await seedDatabase(rt.db);
  const owner=await f.ownerToken(),headers={Authorization:'Bearer '+owner,'Content-Type':'application/json'};
  const probe=await rt.mf.dispatchFetch('http://localhost/identity/probe',{method:'POST',headers,body:'{}'});assert.equal(probe.status,200);const identity=await probe.json();
  assert.equal(identity.uid,f.fixture.config.ownerUid);assert.equal(identity.ownerAllowed,false);assert.equal(settings.ownerUid,null);
  assert.equal((await call(rt.mf,'listIssues',{}, {token:'Bearer '+owner})).error,'owner_not_configured');
  assert.equal((await rt.db.prepare('SELECT count(*) n FROM operations').first()).n,0);
  settings.ownerUid=f.fixture.config.ownerUid;
  const listed=await call(rt.mf,'listIssues',{}, {token:'Bearer '+owner});assert.equal(listed.status,200);
  const operation={operation_id:crypto.randomUUID(),revision:listed.value.revision,changes:[{pmid:'1',expected_version:0,status:'want_fulltext',note:'synthetic real-login route'}]};
  assert.equal((await call(rt.mf,'saveReviews',operation,{token:'Bearer '+owner})).status,200);
  assert.equal((await call(rt.mf,'saveReviews',operation,{token:'Bearer '+owner})).value.replayed,true);
  assert.equal((await rt.db.prepare('SELECT count(*) n FROM operations').first()).n,1);
  assert.equal((await call(rt.mf,'listIssues',{}, {token:'Bearer '+await f.ownerToken({sub:'other-uid'})})).status,403);
  assert.equal((await call(rt.mf,'status',{}, {sync:true,accessToken:await f.syncToken()})).status,403);
});

test('login page exposes only Web config; cross-origin, mock credentials, expired tokens and UID enrollment routes are rejected',async t=>{
  const settings={firebase,ownerUid:f.fixture.config.ownerUid};const rt=await runtime({now:now.toISOString(),ownerLogin:{settings:()=>settings,keyResponses}});t.after(()=>rt.mf.dispose());
  const config=await rt.mf.dispatchFetch('http://localhost/login-config');assert.deepEqual(await config.json(),{firebase});
  assert.equal((await rt.mf.dispatchFetch('http://localhost/')).status,200);
  assert.equal((await call(rt.mf,'listIssues')).status,403);
  const token=await f.ownerToken();assert.equal((await call(rt.mf,'listIssues',{}, {token:'Bearer '+token,origin:'https://untrusted.invalid'})).status,403);
  const response=await rt.mf.dispatchFetch('http://localhost/identity/enroll',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,403);
  assert.equal((await rt.mf.dispatchFetch('https://outside.invalid/')).status,403);
  const expired=await f.ownerToken({exp:Math.floor(now.getTime()/1000)});
  assert.equal((await rt.mf.dispatchFetch('http://localhost/identity/probe',{method:'POST',headers:{Authorization:'Bearer '+expired,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await rt.db.prepare('SELECT count(*) n FROM generations').first()).n,0);
});
