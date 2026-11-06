import {initializeApp} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {initializeAuth,inMemoryPersistence,browserPopupRedirectResolver,GoogleAuthProvider,signInWithPopup,signOut,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
const $=id=>document.getElementById(id);let user=null,busy=false;
const controls=()=>{for(const id of ['backup','import','logout'])$(id).disabled=!user||busy;$('login').disabled=!!user||busy;};
try{
 const config=await(await fetch('/config')).json(),auth=initializeAuth(initializeApp(config.firebase),{persistence:inMemoryPersistence,popupRedirectResolver:browserPopupRedirectResolver});auth.languageCode='ja';
 onAuthStateChanged(auth,active=>{user=active;controls();$('status').textContent=active?'ログインしました。バックアップ操作の準備ができました。':'台帳用アカウントでログインしてください。';});
 $('login').onclick=async()=>{try{const p=new GoogleAuthProvider();p.setCustomParameters({prompt:'select_account'});await signInWithPopup(auth,p);}catch{$('status').textContent='ログインできませんでした。もう一度お試しください。';}};
 $('logout').onclick=()=>signOut(auth);
 for(const [id,path]of [['backup','/backup'],['import','/import-reviews']])$(id).onclick=async()=>{
  busy=true;controls();$('status').textContent='処理中です。この画面を保持してください。';
  try{const token=await user.getIdToken();const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:'{}',redirect:'error'});const result=await response.json();if(!response.ok)throw Error();$('status').textContent=JSON.stringify(result);}
  catch{$('status').textContent='処理を停止しました。結果を確認してから手動で再実行してください。';}finally{busy=false;controls();}
 };
}catch{$('status').textContent='ログインの準備ができませんでした。';}
