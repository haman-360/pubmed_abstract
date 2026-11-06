import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {OnlineEdits} from '../online-state.mjs';
const source=(await fs.readFile(new URL('../online-client.mjs',import.meta.url),'utf8')).replace("import {OnlineEdits} from './state.mjs';",'').replace("import('./sdk.mjs')",'loadSdk()');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor,settle=()=>new Promise(resolve=>setImmediate(resolve));
class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.attributes={};this.hidden=false;this.disabled=false;this.value='';this.textContent='';this.classList={toggle(){}};}
  append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(k,v){this.attributes[k]=v;}replaceWith(){}
  querySelectorAll(selector){const names=selector.split(',');return this.children.flatMap(n=>typeof n==='object'?[...(names.includes(n.tag)?[n]:[]),...n.querySelectorAll(selector)]:[]);}
}
async function setup({loseSave=false,readFailsAfterSave=false,loginFailsOnce=false,holdLogin=false}={}){
  const ids=['data-source','login','login-help','restart-login','logout','welcome','workspace','message','back','reload','period','scope','month-label','month','search','query','clear','summary','list','heading','breadcrumb','description','previous','next','page','savebar','draft-status','save','discard','complete','reopen','retry'];
  const elements=Object.fromEntries(ids.map(id=>[id,new Element(['login','logout','back','reload','clear','previous','next','save','discard','complete','reopen','retry'].includes(id)?'button':'div')]));
  elements.workspace.append(...ids.filter(id=>!['login','logout','welcome','workspace','message'].includes(id)).map(id=>elements[id]));
  const events={},requests=[],operations=new Map(),key='["synthetic-small","感染症"]',revision='a'.repeat(64);let version=0,status='unreviewed',note='',changed,lost=false,pendingRead,popupCalls=0,releasePopup,reloads=0;
  const issue=()=>({issue_key:key,issue_id:'synthetic-small',topic:'感染症',status:'unreviewed',unreviewed:status==='unreviewed'?1:0,total:1,version:0,content_version:'content',delivered_date:'2026-11-06'});
  const sdk={initializeApp:x=>x,inMemoryPersistence:{},browserPopupRedirectResolver:{},initializeAuth:(_a,options)=>{assert.equal(options.persistence,sdk.inMemoryPersistence);return {};},GoogleAuthProvider:class{setCustomParameters(){}},onAuthStateChanged:(_a,fn)=>{changed=fn;fn(null);},signInWithPopup:async()=>{popupCalls++;if(loginFailsOnce&&popupCalls===1)throw {code:'auth/popup-closed-by-user'};if(holdLogin)await new Promise(resolve=>{releasePopup=resolve;});changed({getIdToken:async()=>'synthetic-token'});},signOut:async()=>changed(null)};
  const fetch=async(path,options)=>{
    if(path==='./config.json')return Response.json({firebase:{projectId:'synthetic'}});
    requests.push({path,body:JSON.parse(options.body)});assert.equal(options.headers.Authorization,'Bearer synthetic-token');assert.equal(options.redirect,'error');assert(options.signal);
    if(pendingRead&&path==='/api/listIssues')await pendingRead;
    if(path==='/api/listIssues')return Response.json({value:{items:[issue()],total:1,offset:0,page_size:20,revision,window:{scope:'recent',from:'2026-09-06',through:'2026-11-06'}}});
    if(path==='/api/listIssuePapers'){
      if(readFailsAfterSave&&operations.size)throw Error('offline');
      return Response.json({value:{issue:issue(),items:[{pmid:'1',title:'架空論文',review:{version,status,note}}],total:1,offset:0,page_size:50,revision}});
    }
    assert.equal(path,'/api/saveReviews');const body=JSON.parse(options.body),replayed=operations.has(body.operation_id);
    if(replayed)assert.deepEqual(operations.get(body.operation_id),body);
    else{operations.set(body.operation_id,body);version++;status=body.changes[0].status;note=body.changes[0].note;}
    if(loseSave&&!lost){lost=true;throw Error('response lost');}
    return Response.json({value:{saved:true,replayed}});
  };
  await new AsyncFunction('OnlineEdits','document','fetch','loadSdk','addEventListener','confirm','window',source)(OnlineEdits,{body:new Element(),getElementById:id=>elements[id],createElement:tag=>new Element(tag),querySelector:()=>new Element('a')},fetch,async()=>sdk,(event,fn)=>{events[event]=fn;},()=>true,{scrollTo(){},location:{reload(){reloads++;}}});
  const login=async()=>{await elements.login.onclick();await settle();};
  const open=async()=>{elements.list.querySelectorAll('button')[0].onclick();await settle();};
  const edit=()=>{const select=elements.list.querySelectorAll('select')[0],textarea=elements.list.querySelectorAll('textarea')[0];select.value='want_fulltext';select.onchange();textarea.value='架空の画面メモ';textarea.oninput();};
  return {elements,requests,operations,login,open,edit,changed:()=>changed,popupCalls:()=>popupCalls,releasePopup:()=>releasePopup(),reloads:()=>reloads,deferRead:()=>{let release;pendingRead=new Promise(resolve=>{release=resolve;});return release;}};
}
test('online client keeps an unknown save fixed, replays once, and clears data on signout',async()=>{
  const c=await setup({loseSave:true}),e=c.elements;await c.login();assert.equal(c.requests[0].body.scope,'recent');await c.open();assert.equal(e.complete.disabled,true);c.edit();assert.equal(e.complete.disabled,false);
  await e.save.onclick();assert.equal(c.operations.size,1);assert.equal(e.retry.hidden,false);assert.equal(e.save.disabled,true);
  await e.retry.onclick();assert.equal(c.operations.size,1);assert.equal(e.retry.hidden,true);assert.match(e.message.textContent,/保存を確認/);
  await e.logout.onclick();assert.equal(e.workspace.hidden,true);assert.equal(e.list.children.length,0);assert.equal(e.login.disabled,false);
});
test('acknowledged saves remain acknowledged if the following read fails',async()=>{
  const c=await setup({readFailsAfterSave:true}),e=c.elements;await c.login();await c.open();c.edit();await e.save.onclick();
  assert.equal(c.operations.size,1);assert.equal(e.retry.hidden,true);assert.match(e.message.textContent,/保存は完了.*再取得できません/);
});
test('late data and auth callbacks cannot restore a signed-out online session',async()=>{
  const c=await setup(),e=c.elements;const release=c.deferRead();await c.login();await e.logout.onclick();release();await settle();
  assert.equal(e.workspace.hidden,true);assert.equal(e.list.children.length,0);assert.equal(e.login.disabled,false);
  c.changed()({getIdToken:async()=>'must-not-be-used'});await settle();assert.equal(e.workspace.hidden,true);assert.equal(c.requests.length,1);
});
test('a failed popup can be retried without quitting; login reset cannot discard signed-in edits',async()=>{
  const c=await setup({loginFailsOnce:true}),e=c.elements;await c.login();
  assert.equal(e.login.disabled,false);assert.equal(e['login-help'].open,true);assert.match(e.message.textContent,/ログイン画面を開き直す/);assert.equal(c.requests.length,0);
  await c.login();assert.equal(c.popupCalls(),2);assert.equal(e.workspace.hidden,false);await c.open();c.edit();
  assert.equal(e['restart-login'].disabled,true);e['restart-login'].onclick();assert.equal(c.reloads(),0);assert.equal(c.operations.size,0);
});
test('a pending popup stays locked through a null auth callback; manual reset ignores late auth',async()=>{
  const c=await setup({holdLogin:true}),e=c.elements,pending=e.login.onclick();await settle();
  c.changed()(null);assert.equal(e.login.disabled,true);await e.login.onclick();assert.equal(c.popupCalls(),1);
  assert.equal(e['restart-login'].disabled,false);e['restart-login'].onclick();assert.equal(c.reloads(),1);
  c.releasePopup();await pending;assert.equal(e.workspace.hidden,true);assert.equal(c.requests.length,0);
});
test('popup completion does not unlock the workspace while the initial ledger read is pending',async()=>{
  const c=await setup(),e=c.elements,release=c.deferRead();await c.login();
  assert.equal(e.reload.disabled,true);release();await settle();assert.equal(e.reload.disabled,false);
});
