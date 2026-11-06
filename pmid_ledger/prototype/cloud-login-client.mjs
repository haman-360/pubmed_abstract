const $=id=>document.getElementById(id),ISSUE='["synthetic-small","感染症"]',NOTE='クラウドTEST保存確認';
let auth,sdk,user=null,version=0,allowed=false,busy=false,pending=null;
const message=value=>{$('status').textContent=value;};
function controls(){ $('login').disabled=!!user||busy;$('logout').disabled=!user;$('check').disabled=!user||busy;$('save').disabled=!allowed||busy; }
function errorText(e){return ({'auth/popup-closed-by-user':'ログイン画面が閉じられました。もう一度お試しください。','auth/unauthorized-domain':'Firebaseのlocalhost設定を確認してください。',identity_denied:'本人認証を確認できません。Googleアカウントを確認してください。',cloud_request_result_unknown_no_automatic_retry:'保存結果を確認できません。同じ画面の保存ボタンで、同じ操作を再確認できます。'})[e.code??e.message]??'確認できませんでした。この画面を保持して、表示された状況をお知らせください。';}
async function call(path,body,force=false){
  const active=user,tag=version;if(!active)throw Error('identity_denied');const token=await active.getIdToken(force);
  if(tag!==version||active!==user)throw Error('stale');
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
  const data=await response.json();if(tag!==version||active!==user)throw Error('stale');
  if(!response.ok)throw Error(data.error);return data;
}
async function check(force=false){
  const tag=version;busy=true;allowed=false;controls();
  try{
    const probe=await call('/identity/probe',{},force);if(!probe.ownerAllowed)throw Error('identity_denied');
    const list=await call('/api/listIssues',{scope:'all'});
    const small=await call('/api/listIssuePapers',{issue_key:ISSUE});
    if(list.value.total!==6||small.value.total!==1||small.value.items[0]?.pmid!=='1')throw Error('synthetic_fixture_required');
    if(tag===version){allowed=true;message('本人認証と、クラウドの架空6配信を確認できました。保存確認へ進めます。');}
  }catch(e){if(tag===version&&e.message!=='stale')message(errorText(e));}
  finally{if(tag===version){busy=false;controls();}}
}
$('login').onclick=async()=>{const tag=version;busy=true;controls();try{const provider=new sdk.GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});await sdk.signInWithPopup(auth,provider);}catch(e){if(tag===version)message(errorText(e));}finally{if(tag===version){busy=false;controls();}}};
$('logout').onclick=async()=>{version++;user=null;allowed=false;busy=false;pending=null;controls();message('この画面からサインアウトしました。');try{await sdk.signOut(auth);}catch{}if(!user)message('この画面からサインアウトしました。');controls();};
$('check').onclick=()=>check(true);
$('save').onclick=async()=>{
  const tag=version;busy=true;controls();const started=performance.now();
  try{
    if(!pending){
      const before=await call('/api/listIssuePapers',{issue_key:ISSUE}),paper=before.value.items[0];
      if(before.value.total!==1||paper?.pmid!=='1')throw Error('synthetic_fixture_required');
      pending={operation_id:crypto.randomUUID(),revision:before.value.revision,changes:[{pmid:'1',expected_version:paper.review.version,status:'want_fulltext',note:NOTE}]};
    }
    const request=pending,first=await call('/api/saveReviews',request);
    if(!first.value.saved)throw Error('save_not_confirmed');
    const replay=await call('/api/saveReviews',request);
    if(!replay.value.saved||replay.value.replayed!==true)throw Error('replay_not_confirmed');
    const after=await call('/api/listIssuePapers',{issue_key:ISSUE}),paper=after.value.items[0];
    if(paper?.pmid!=='1'||paper.review.status!=='want_fulltext'||paper.review.note!==NOTE||paper.review.version!==request.changes[0].expected_version+1)throw Error('readback_mismatch');
    await call('/api/getPaperDetail',{pmid:'1',issue_key:ISSUE});
    if(tag===version){pending=null;message(`保存・読戻し・同じ操作の再送を確認できました。論文の版数：${paper.review.version}。確認まで${((performance.now()-started)/1000).toFixed(2)}秒。`);}
  }catch(e){if(tag===version&&e.message!=='stale')message(errorText(e));}
  finally{if(tag===version){busy=false;controls();}}
};
try{
  sdk=await import('/firebase-sdk.mjs');const response=await fetch('/login-config');if(!response.ok)throw Error();const config=await response.json();
  auth=sdk.initializeAuth(sdk.initializeApp(config.firebase),{persistence:sdk.inMemoryPersistence,popupRedirectResolver:sdk.browserPopupRedirectResolver});auth.languageCode='ja';
  sdk.onAuthStateChanged(auth,active=>{version++;user=active;allowed=false;busy=false;pending=null;controls();if(active)check();else message('Googleでログインして、本人のクラウド保存を確認します。');});
}catch{message('ログインの準備ができませんでした。ローカル設定と接続を確認してください。');}
