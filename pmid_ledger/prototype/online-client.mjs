import {OnlineEdits} from './state.mjs';
const $=id=>document.getElementById(id),edits=new OnlineEdits();
const launchMedia=window.matchMedia?.('(display-mode: standalone)');
function showLaunchMode(){const label=$('launch-mode');if(label)label.textContent=launchMedia?.matches||window.navigator?.standalone===true?'アプリで起動中':'ブラウザで起動中';}
showLaunchMode();launchMedia?.addEventListener?.('change',showLaunchMode);
const statusLabels={unreviewed:'未確認',reviewed_no_fulltext:'原本不要',want_fulltext:'入手希望'},legacyLabels={fulltext_obtained:'原文入手済み未読',read:'読了'};
const issueLabels={unreviewed:'未確認',in_progress:'確認中',completed:'確認済み'};
const issueClasses={unreviewed:'unreviewed',in_progress:'in-progress',completed:'complete'};
let sdk,auth,user=null,epoch=0,view=0,busy=false,loginPending=false,manualSignout=false,key=null,current=null,offset=0,total=0,issueOffset=0,scope='recent',month='';
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function controls(){
  $('login').disabled=!auth||!!user||busy||loginPending;$('logout').hidden=!user;$('logout').disabled=false;
  $('restart-login').disabled=!!user;
  for(const el of $('workspace').querySelectorAll('button,input,select,textarea'))el.disabled=busy||!!edits.pending;
  $('retry').hidden=!edits.pending;$('retry').disabled=busy;$('discard').disabled=busy;
  $('previous').disabled=busy||!!edits.pending||offset===0;$('next').disabled=busy||!!edits.pending||offset+(key?50:20)>=total;
  $('save').disabled=busy||!!edits.pending||!edits.drafts.size;
  $('complete').disabled=busy||!!edits.pending||current?.issue.status==='completed'||edits.unreviewedAfterEdits!==0;
  $('reopen').hidden=current?.issue.status!=='completed';
  $('draft-status').textContent=edits.pending?'保存結果の確認待ちです。編集を固定しています。':`未保存 ${edits.drafts.size}件（この画面内のみ） · 保存後の未確認見込み ${edits.unreviewedAfterEdits??'—'}件`;
}
const descriptions={identity_denied:'本人認証を確認できません。サインアウトして、台帳用のGoogleアカウントでログインしてください。',conflict_or_invalid_atomic_operation:'ほかの画面の変更、または未確認の論文が残っています。編集を控えたうえで、再取得してください。',metadata_changed_reload:'配信内容が更新されました。編集を控えたうえで、再取得してください。',too_many_changes:'一度に保存できる変更は100件までです。',save_before_reopen:'先に編集中の内容を保存してください。',daily_d1_limit:'本日の無料枠の上限に達しました。24時間後にもう一度アクセスしてください。','auth/popup-blocked':'ポップアップがブロックされました。このサイトのログイン用ポップアップを許可して、もう一度押してください。','auth/popup-closed-by-user':'ログイン画面が閉じられました。もう一度ログインできます。','auth/unauthorized-domain':'このTESTホストのGoogleログイン設定を確認してください。'};
function describe(error){return descriptions[error.code??error.message]??'通信を確認できませんでした。接続を確認して、手動でもう一度お試しください。';}
async function rpc(name,body){
  const active=user,tag=epoch;if(!active)throw Error('identity_denied');
  const token=await active.getIdToken();if(tag!==epoch||active!==user)throw Error('stale');
  const response=await fetch('/api/'+name,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'});
  const data=await response.json();if(tag!==epoch||active!==user)throw Error('stale');
  if(!response.ok)throw Object.assign(Error(data.error??'request_failed'),{status:response.status});return data.value;
}
const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
function counters(data){$('summary').replaceChildren(...Object.entries(data).map(([name,count])=>node('span',`${name} ${count}`)));}
function pagination(data){offset=data.offset;total=data.total;$('page').textContent=total?`${offset+1}–${Math.min(offset+data.page_size,total)} / ${total}件`:'0件';$('previous').hidden=offset===0;$('next').hidden=offset+data.page_size>=total;}
function renderIssues(data){
  $('data-source').textContent=['real-copy','recent-copy'].includes(data.data_source)?'試用環境 · 実データのコピー':'試用環境 · 架空データ';
  $('heading').textContent='配信一覧';$('breadcrumb').textContent='研究台帳 / 配信';
  $('description').textContent=data.window.scope==='recent'?`${data.window.from} 〜 ${data.window.through} · 直近2か月`:data.window.scope==='unknown'?'配信日が不明なもの':`${month}の配信`;
  $('list').className='issue-grid';$('list').replaceChildren();counters({'配信':data.total});
  for(const issue of data.items){
    const card=node('article',undefined,'issue-card'),meta=node('div',undefined,'issue-meta');
    meta.append(node('span',issue.delivered_date||'配信日不明'),node('span',issueLabels[issue.status]??issue.status,'pill '+(issueClasses[issue.status]??'')));
    const button=node('button','論文を確認する');button.onclick=()=>{key=issue.issue_key;offset=0;$('query').value='';edits.reset();load();};
    card.append(meta,node('h2',issue.topic),node('p',issue.issue_id,'muted'),node('p',`${issue.total}論文 · 未確認 ${issue.unreviewed}`,'counts'),button);$('list').append(card);
  }
  if(!data.items.length)$('list').append(node('p','この期間に配信はありません。過去の月を指定して確認できます。','empty'));
}
function renderPapers(data){
  edits.observe(data);current=data;$('heading').textContent=data.issue.topic;$('breadcrumb').textContent='研究台帳 / 論文';$('description').textContent=`${data.issue.delivered_date||'配信日不明'} · ${data.issue.issue_id}`;
  $('list').className='paper-list';$('list').replaceChildren();counters({'論文':data.issue.total,'未確認':data.issue.unreviewed});
  for(const row of data.items){
    const card=node('article',undefined,'paper-card'),meta=node('div',undefined,'paper-meta');meta.append(node('span',`PMID ${row.pmid}`));
    const title=node('h2',row.title),pubmed=node('a','PubMed ↗');pubmed.href='https://pubmed.ncbi.nlm.nih.gov/'+encodeURIComponent(row.pmid)+'/';pubmed.target='_blank';pubmed.rel='noopener noreferrer';title.append(pubmed);
    const fields=node('div',undefined,'paper-edit'),statusLabel=node('label','状態'),select=node('select'),noteLabel=node('label','メモ'),note=node('textarea');
    select.setAttribute('aria-label',`PMID ${row.pmid} 状態`);note.setAttribute('aria-label',`PMID ${row.pmid} メモ`);note.maxLength=2000;note.rows=3;note.placeholder='入手先や確認したことを記録';
    const draft=edits.drafts.get(row.pmid),savedStatus=draft?.status??row.review.status;
    if(!statusLabels[savedStatus]){const old=node('option',`旧状態を保持：${legacyLabels[savedStatus]??savedStatus}`);old.value=savedStatus;old.disabled=true;select.append(old);}
    for(const [value,label]of Object.entries(statusLabels)){const option=node('option',label);option.value=value;select.append(option);}select.value=savedStatus;note.value=draft?.note??row.review.note;
    const update=()=>{edits.edit(row,select.value,note.value);controls();};select.onchange=update;note.oninput=update;
    statusLabel.append(select);noteLabel.append(note);fields.append(statusLabel,noteLabel);card.append(meta,title);
    if(row.score)card.append(node('p',`評価 ${row.score.total??'—'} · ${row.score.usefulness??''}${row.score.memo?'\n'+row.score.memo:''}`,'score'));
    card.append(fields);
    const detail=node('button','本文を開く', 'detail-button');detail.onclick=async()=>{
      const tag=view;detail.disabled=true;
      try{const result=await rpc('getPaperDetail',{pmid:row.pmid,issue_key:key});if(tag!==view)return;
        const region=node('div',undefined,'detail-body');region.setAttribute('aria-label',`PMID ${row.pmid} 本文`);
        for(const a of result.appearances){const text=a.text?.summary_ja||a.text?.abstract||'本文は登録されていません。';region.append(node('p',a.title_at_delivery||row.title),node('p',text.slice(0,12000)));
          if(text.length>12000)region.append(node('p','長い本文は先頭12,000文字を表示しています。','hint'));
          try{const url=new URL(a.current_doc_url);if(url.protocol==='https:'&&url.hostname==='docs.google.com'){const link=node('a','配信文書を開く ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';region.append(link);}}catch{}
        }detail.replaceWith(region);
      }catch(e){if(e.message!=='stale'&&tag===view){message(describe(e),true);detail.disabled=false;}}
    };card.append(detail);$('list').append(card);
  }
  if(!data.items.length)$('list').append(node('p','該当する論文はありません。検索条件を変更してください。','empty'));
}
async function load(){
  const tag=epoch,serial=++view;busy=true;controls();
  try{
    const data=await rpc(key?'listIssuePapers':'listIssues',key?{issue_key:key,offset,query:$('query').value}:{scope,month,offset:issueOffset});
    if(tag!==epoch||serial!==view)return;
    $('workspace').hidden=false;$('welcome').hidden=true;$('back').hidden=!key;$('search').hidden=!key;$('period').hidden=!!key;$('savebar').hidden=!key;
    if(key)renderPapers(data);else{renderIssues(data);issueOffset=data.offset;current=null;}pagination(data);document.body.classList.toggle('editing',!!key);window.scrollTo({top:0,behavior:'auto'});message('');return true;
  }catch(e){if(tag===epoch&&e.message!=='stale')message(describe(e),true);return false;}
  finally{if(tag===epoch){busy=false;controls();}}
}
function discard(){if(edits.dirty&&!confirm('未保存の編集と、結果確認待ちの要求を破棄しますか？ 結果不明の保存は、すでに反映されている場合があります。'))return false;edits.reset();return true;}
async function submit(kind='save'){
  const tag=epoch;let request;
  try{request=edits.request(kind);if(!request){message('変更はありません。');return;}}catch(e){message(describe(e),true);return;}
  busy=true;controls();message('保存結果を確認しています…');
  try{const result=await rpc(request.name,request.body);if(tag!==epoch)return;edits.acknowledge(result);const loaded=await load();if(tag===epoch)message(loaded?(result.completed?'保存し、配信を確認済みにしました。':'保存を確認しました。'):'保存は完了しましたが、一覧を再取得できません。接続後に再読み込みしてください。',!loaded);}
  catch(e){if(tag===epoch&&e.message!=='stale')message(`保存結果を確認できません。${describe(e)}\n編集を固定しています。「同じ操作を再確認」で同じ操作ID・内容を送れます。`,true);}
  finally{if(tag===epoch){busy=false;controls();}}
}
function clearIdentity(){epoch++;view++;user=null;busy=false;key=null;current=null;offset=0;issueOffset=0;edits.reset();$('list').replaceChildren();$('summary').replaceChildren();$('query').value='';$('workspace').hidden=true;$('welcome').hidden=false;document.body.classList.toggle('editing',false);controls();}
$('login').onclick=async()=>{
  if(!auth||user||loginPending)return;
  loginPending=true;manualSignout=false;controls();message('Googleのログイン画面でアカウントを選んでください。');
  try{const provider=new sdk.GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});await sdk.signInWithPopup(auth,provider);}
  catch(e){if(!user&&!manualSignout){$('login-help').open=true;message(describe(e)+'\nログイン画面でエラーが出た場合は、画面を閉じてもう一度ログインしてください。押せない場合は「ログイン画面を開き直す」を使えます。',true);}}
  finally{loginPending=false;controls();}
};
$('restart-login').onclick=()=>{if(user||edits.dirty)return;manualSignout=true;window.location.reload();};
$('logout').onclick=async()=>{if(!discard())return;manualSignout=true;clearIdentity();message('サインアウトしました。この画面の台帳データと編集を消去しました。');try{await sdk.signOut(auth);}catch{message('サインアウトを完了できませんでした。この画面を閉じてください。',true);}};
$('back').onclick=()=>{if(discard()){key=null;current=null;offset=issueOffset;$('query').value='';load();}};
document.querySelector('.brand').onclick=e=>{e.preventDefault();if(user&&discard()){key=null;current=null;offset=issueOffset;load();}};
$('reload').onclick=()=>{if(discard())load();};$('discard').onclick=()=>{if(discard())load();};
$('previous').onclick=()=>{offset=Math.max(0,offset-(key?50:20));if(!key)issueOffset=offset;load();};
$('next').onclick=()=>{offset+=key?50:20;if(!key)issueOffset=offset;load();};
$('scope').onchange=()=>{$('month-label').hidden=$('scope').value!=='month';};
$('period').onsubmit=e=>{e.preventDefault();if(!discard())return;if($('scope').value==='month'&&!/^\d{4}-(0[1-9]|1[0-2])$/.test($('month').value)){message('対象月を選んでください。',true);return;}scope=$('scope').value;month=$('month').value;issueOffset=0;offset=0;load();};
$('search').onsubmit=e=>{e.preventDefault();offset=0;load();};$('clear').onclick=()=>{$('query').value='';offset=0;load();};
$('save').onclick=()=>submit();$('complete').onclick=()=>submit('complete');$('reopen').onclick=()=>{if(confirm('配信を未確認に戻しますか？ 論文の状態とメモは保持します。'))submit('reopen');};$('retry').onclick=()=>submit();
addEventListener('beforeunload',e=>{if(edits.dirty){e.preventDefault();e.returnValue='';}});
addEventListener('offline',()=>message('オフラインです。編集はこの画面内だけにあります。接続後、保存結果を手動で確認してください。',true));
try{
  sdk=await import('./sdk.mjs');const response=await fetch('./config.json',{cache:'no-store',redirect:'error'});if(!response.ok)throw Error('configuration');const config=await response.json();
  auth=sdk.initializeAuth(sdk.initializeApp(config.firebase),{persistence:sdk.inMemoryPersistence,popupRedirectResolver:sdk.browserPopupRedirectResolver});auth.languageCode='ja';
  sdk.onAuthStateChanged(auth,active=>{if(manualSignout&&active)return;if(!active&&loginPending)return;clearIdentity();user=active;controls();if(active){message('本人認証と配信一覧を確認しています…');load();}else if(!manualSignout)message('Googleでログインして、台帳を開いてください。');});
}catch{message('ログインの準備ができませんでした。オンライン接続とTEST設定を確認して、再読み込みしてください。',true);}
