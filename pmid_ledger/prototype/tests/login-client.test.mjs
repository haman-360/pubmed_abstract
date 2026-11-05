import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const source=await fs.readFile(new URL('../login-client.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function client({sdkFails=false}={}){
  const elements=Object.fromEntries(['status','login','logout','check','read','identity','account','uid','owner-state'].map(id=>[id,{disabled:true,hidden:false,textContent:''}]));
  let changed,configured=false,pending,refreshes=0,failure;
  const sdk={initializeApp:c=>c,inMemoryPersistence:{},browserPopupRedirectResolver:{},initializeAuth:(_app,options)=>{
    assert.equal(options.persistence,sdk.inMemoryPersistence);assert.equal(options.popupRedirectResolver,sdk.browserPopupRedirectResolver);return {};
  },GoogleAuthProvider:class{setCustomParameters(value){assert.equal(value.prompt,'select_account');}},onAuthStateChanged:(_auth,fn)=>{changed=fn;fn(null);},
  signInWithPopup:async()=>{if(failure)throw {code:failure};changed({getIdToken:async force=>{if(force)refreshes++;return 'synthetic-token';}});},signOut:async()=>changed(null)};
  const fetch=async(path,options)=>{
    if(path==='/login-config')return Response.json({firebase:{projectId:'synthetic'}});
    assert.equal(options.headers.Authorization,'Bearer synthetic-token');
    if(path==='/identity/probe'){
      if(pending)await pending;
      return Response.json({uid:'verified-synthetic-uid',email:'synthetic@example.invalid',ownerConfigured:configured,ownerAllowed:configured});
    }
    assert.equal(path,'/api/listIssues');return Response.json({value:{total:2}});
  };
  const load=async()=>{if(sdkFails)throw Error('offline');return sdk;};
  await new AsyncFunction('document','fetch','load',source.replace("import('/firebase-sdk.mjs')",'load()'))({getElementById:id=>elements[id]},fetch,load);
  return {elements,pin:()=>{configured=true;},refreshes:()=>refreshes,fail:code=>{failure=code;},defer:()=>{let release;pending=new Promise(resolve=>{release=resolve;});return release;}};
}
test('login client uses memory persistence, requires explicit pin, refreshes token, reads fake data and clears identity on sign-out',async()=>{
  const c=await client(),e=c.elements;assert.equal(e.login.disabled,false);
  await e.login.onclick();await settle();assert.equal(e.uid.textContent,'verified-synthetic-uid');assert.equal(e.read.disabled,true);
  c.pin();await e.check.onclick();assert.equal(c.refreshes(),1);assert.equal(e.read.disabled,false);
  await e.read.onclick();assert.match(e.status.textContent,/2件/);
  await e.logout.onclick();assert.equal(e.uid.textContent,'');assert.equal(e.identity.hidden,true);assert.equal(e.read.disabled,true);assert.equal(e.login.disabled,false);
});
test('late probe after sign-out cannot repopulate identity; SDK load and popup/domain errors leave usable messages',async()=>{
  const c=await client(),e=c.elements,release=c.defer();await e.login.onclick();await e.logout.onclick();release();await settle();
  assert.equal(e.uid.textContent,'');assert.equal(e.identity.hidden,true);assert.equal(e.read.disabled,true);
  c.fail('auth/unauthorized-domain');await e.login.onclick();assert.match(e.status.textContent,/localhost/);assert.equal(e.login.disabled,false);
  c.fail('auth/popup-closed-by-user');await e.login.onclick();assert.match(e.status.textContent,/閉じられました/);
  const unavailable=await client({sdkFails:true});assert.match(unavailable.elements.status.textContent,/準備ができません/);assert.equal(unavailable.elements.login.disabled,true);
});
