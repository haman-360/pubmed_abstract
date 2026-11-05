let initializeApp,initializeAuth,inMemoryPersistence,browserPopupRedirectResolver,GoogleAuthProvider,signInWithPopup,signOut,onAuthStateChanged;
const $=id=>document.getElementById(id);let auth,version=0,user=null,allowed=false;
function message(value){$('status').textContent=value;}
function clear(){allowed=false;$('identity').hidden=true;$('account').textContent='';$('uid').textContent='';$('owner-state').textContent='';$('read').disabled=true;}
function errorText(e){
  const messages={'auth/unauthorized-domain':'Firebaseの承認済みドメインにlocalhostを追加してください。','auth/popup-blocked':'ポップアップを許可してから、もう一度ログインしてください。','auth/popup-closed-by-user':'ログイン画面が閉じられました。必要なときにもう一度ログインしてください。','auth/invalid-api-key':'Firebase Web設定のAPIキーを確認してください。','auth/network-request-failed':'ネットワーク接続を確認して、もう一度お試しください。',identity_denied:'認証を確認できません。Googleアカウントを確認して、もう一度ログインしてください。',owner_not_configured:'本人UIDの設定がまだ完了していません。'};
  return messages[e.code??e.message]??'確認できませんでした。接続を確認して、もう一度お試しください。';
}
async function call(path,body,force=false){
  const active=user,tag=version;if(!active)throw new Error('identity_denied');const token=await active.getIdToken(force);
  if(tag!==version||active!==user)throw new Error('stale');
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)}),data=await r.json();
  if(tag!==version||active!==user)throw new Error('stale');if(!r.ok)throw new Error(data.error);return data;
}
async function check(force=false){
  const tag=version;allowed=false;$('read').disabled=true;$('check').disabled=true;
  try{const result=await call('/identity/probe',{},force);if(tag!==version)return;
    $('identity').hidden=false;$('account').textContent=result.email||'Googleアカウントを確認しました。';$('uid').textContent=result.uid;
    allowed=result.ownerAllowed;$('owner-state').textContent=allowed?'本人UIDと一致しています。':result.ownerConfigured?'このアカウントは設定された本人UIDと一致しません。':'Googleログインを確認しました。本人UIDの設定が完了するまで台帳データは開けません。';
    message(allowed?'Googleログインと本人UIDを確認できました。':'Googleの署名・発行元・期限を確認できました。');
  }catch(e){if(tag===version&&e.message!=='stale'){clear();message(errorText(e));}}
  finally{if(tag===version){$('check').disabled=!user;$('read').disabled=!allowed;}}
}
$('login').onclick=async()=>{const tag=version;$('login').disabled=true;try{const provider=new GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});await signInWithPopup(auth,provider);}catch(e){if(tag===version)message(errorText(e));}finally{$('login').disabled=!!user;}};
$('logout').onclick=async()=>{version++;user=null;clear();$('check').disabled=true;$('logout').disabled=true;message('この画面からサインアウトしました。');try{await signOut(auth);}catch{message('画面の認証情報を消去しました。必要なときにもう一度ログインしてください。');}$('login').disabled=false;};
$('check').onclick=()=>check(true);
$('read').onclick=async()=>{const tag=version;try{const data=await call('/api/listIssues',{scope:'recent'});if(tag===version)message(`本人認証で架空データを取得できました。直近2か月の配信：${data.value.total}件。`);}catch(e){if(tag===version&&e.message!=='stale'){if(['identity_denied','owner_not_configured'].includes(e.message))clear();message(errorText(e));}}};
try{
  ({initializeApp,initializeAuth,inMemoryPersistence,browserPopupRedirectResolver,GoogleAuthProvider,signInWithPopup,signOut,onAuthStateChanged}=await import('/firebase-sdk.mjs'));
  const response=await fetch('/login-config');if(!response.ok)throw new Error();const config=await response.json();
  auth=initializeAuth(initializeApp(config.firebase),{persistence:inMemoryPersistence,popupRedirectResolver:browserPopupRedirectResolver});auth.languageCode='ja';
  onAuthStateChanged(auth,active=>{version++;user=active;clear();$('login').disabled=!!active;$('logout').disabled=!active;$('check').disabled=!active;if(active)check();else message('Googleでログインして認証を確認します。');});
}catch{message('ログインの準備ができませんでした。ネットワークとローカル設定を確認してください。');}
