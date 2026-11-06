import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const source=await fs.readFile(new URL('../cloud-login-client.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function client({sdkFails=false,loseFirstSave=false}={}){
  const elements=Object.fromEntries(['status','login','logout','check','save','measure','cpu','measurements'].map(id=>[id,{disabled:true,textContent:''}]));
  const operations=new Map(),requests=[];let changed,revision=0,refreshes=0,pending,lost=false;
  const sdk={initializeApp:c=>c,inMemoryPersistence:{},browserPopupRedirectResolver:{},initializeAuth:(_app,options)=>{
    assert.equal(options.persistence,sdk.inMemoryPersistence);assert.equal(options.popupRedirectResolver,sdk.browserPopupRedirectResolver);return {};
  },GoogleAuthProvider:class{setCustomParameters(p){assert.equal(p.prompt,'select_account');}},onAuthStateChanged:(_auth,fn)=>{changed=fn;fn(null);},
  signInWithPopup:async()=>changed({getIdToken:async force=>{if(force)refreshes++;return 'synthetic-owner-token';}}),signOut:async()=>changed(null)};
  const fetch=async(path,options)=>{
    if(path==='/login-config')return Response.json({firebase:{projectId:'synthetic'}});
    assert.equal(options.headers.Authorization,'Bearer synthetic-owner-token');requests.push(path);
    if(pending)await pending;
    const body=JSON.parse(options.body);
    if(path==='/identity/probe')return Response.json({ownerAllowed:true});
    if(path==='/api/listIssues')return Response.json({value:{total:6}});
    if(path==='/api/listIssuePapers')return Response.json({value:{total:1,revision:'a'.repeat(64),items:[{pmid:'1',review:{version:revision,status:revision?'want_fulltext':'unreviewed',note:revision?'クラウドTEST保存確認':''}}]}});
    if(path==='/api/getPaperDetail')return Response.json({value:{appearances:[]}});
    assert.equal(path,'/api/saveReviews');
    const replayed=operations.has(body.operation_id);
    if(!replayed){operations.set(body.operation_id,body);revision++;}
    else assert.deepEqual(operations.get(body.operation_id),body);
    if(loseFirstSave&&!lost){lost=true;throw Error('network unavailable');}
    return Response.json({value:{saved:true,replayed,revision:'a'.repeat(64),reviews:[{review:{version:revision,status:'want_fulltext',note:'クラウドTEST保存確認'}}]}});
  };
  await new AsyncFunction('document','fetch','load',source.replace("import('/firebase-sdk.mjs')",'load()'))(
    {getElementById:id=>elements[id]},fetch,async()=>{if(sdkFails)throw Error('offline');return sdk;});
  return {elements,operations,requests,refreshes:()=>refreshes,defer:()=>{let release;pending=new Promise(resolve=>{release=resolve;});return release;}};
}
test('cloud login uses memory-only auth, verifies fixture, saves and replays one operation, then clears on sign-out',async()=>{
  const c=await client(),e=c.elements;assert.equal(e.login.disabled,false);
  await e.login.onclick();await settle();assert.equal(e.save.disabled,false);assert.match(e.status.textContent,/架空6配信/);
  await e.check.onclick();assert.equal(c.refreshes(),1);
  await e.save.onclick();assert.equal(c.operations.size,1);assert.match(e.status.textContent,/保存・読戻し/);
  assert.equal(c.requests.filter(p=>p==='/api/saveReviews').length,2);
  await e.logout.onclick();assert.equal(e.save.disabled,true);assert.equal(e.login.disabled,false);assert.match(e.status.textContent,/サインアウト/);
});
test('unknown save results retry the identical operation; sign-out rejects late probes and SDK failure stays disabled',async()=>{
  const c=await client({loseFirstSave:true}),e=c.elements;
  await e.login.onclick();await settle();await e.save.onclick();assert.equal(c.operations.size,1);assert.equal(e.measure.disabled,true);
  await e.measure.onclick();assert.equal(c.operations.size,1);
  await e.save.onclick();assert.equal(c.operations.size,1);assert.match(e.status.textContent,/保存・読戻し/);assert.equal(e.measure.disabled,false);
  const late=await client(),release=late.defer();await late.elements.login.onclick();await late.elements.logout.onclick();release();await settle();
  assert.equal(late.elements.save.disabled,true);assert.match(late.elements.status.textContent,/サインアウト/);
  const failed=await client({sdkFails:true});assert.equal(failed.elements.login.disabled,true);assert.match(failed.elements.status.textContent,/準備ができません/);
});
test('bounded speed samples save only the fixed paper; CPU capture traffic is read-only and reports omit tokens',async()=>{
  const c=await client(),e=c.elements;await e.login.onclick();await settle();
  await e.measure.onclick();assert.equal(c.operations.size,10);
  const report=JSON.parse(e.measurements.textContent);assert.equal(report.save_readback_verified,true);
  for(const value of Object.values(report.operations)){assert.equal(value.samples,10);assert(Number.isFinite(value.median_ms));}
  assert(!e.measurements.textContent.includes('synthetic-owner-token'));
  const before=c.requests.length;await e.cpu.onclick();assert.equal(c.requests.length-before,80);assert.equal(c.operations.size,10);
  assert(c.requests.slice(before).every(path=>path==='/api/getPaperDetail'));
});
