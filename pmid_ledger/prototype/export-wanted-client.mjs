import {initializeApp} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {initializeAuth,inMemoryPersistence,browserPopupRedirectResolver,GoogleAuthProvider,signInWithPopup,signOut} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
const $=id=>document.getElementById(id);let auth,user;
try{
  const config=await (await fetch('/config',{cache:'no-store',redirect:'error'})).json();
  auth=initializeAuth(initializeApp(config.firebase),{persistence:inMemoryPersistence,popupRedirectResolver:browserPopupRedirectResolver});
  auth.languageCode='ja';$('login').disabled=false;$('message').textContent='台帳と同じGoogleアカウントでログインしてください。';
}catch{$('message').textContent='ログインの準備ができません。接続を確認して開き直してください。';}
$('login').onclick=async()=>{
  $('login').disabled=true;
  try{user=(await signInWithPopup(auth,new GoogleAuthProvider())).user;$('login').hidden=true;$('export').hidden=false;$('message').textContent='希望PMIDをTXTへ保存できます。';}
  catch{$('login').disabled=false;$('message').textContent='ログインできませんでした。エラー画面を閉じてもう一度ログインしてください。';}
};
$('export').onclick=async()=>{
  $('export').disabled=true;$('message').textContent='希望PMIDを取得しています…';
  try{
    const response=await fetch('/export',{method:'POST',redirect:'error',signal:AbortSignal.timeout(120000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+await user.getIdToken()},body:'{}'});
    const result=await response.json();
    if(!response.ok){$('message').textContent=result.error==='export_changed_restart'?'出力中に台帳が更新されました。もう一度出力してください。':'出力できませんでした。アプリ側の更新・接続・本人アカウントを確認して再実行してください。';$('export').disabled=false;return;}
    $('message').textContent=`${result.count}件を保存しました。\n${result.path}\nこの画面は閉じて構いません。`;
    await signOut(auth);user=null;
  }catch{$('message').textContent='保存結果を確認できません。ターミナルと出力フォルダを確認してください。再実行しても既存ファイルは上書きしません。';}
};
