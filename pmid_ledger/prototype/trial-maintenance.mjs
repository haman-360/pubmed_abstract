// Loopback-only owner maintenance. No credentials are stored or returned to the browser.
import http from 'node:http';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readLoginSettings} from './login-settings.mjs';
import {createOwnerVerifier} from './identity.mjs';
import {createOwnerKeySource} from './identity-keys.mjs';
import {validateCloudOrigin} from './cloud-login-proxy.mjs';
import {downloadBackup,consumeBackup} from './backup-client.mjs';
import {readBackupLines} from './backup-file.mjs';
import {restoreStream} from './restore-stream.mjs';
import {runtime} from './runtime.mjs';
import {runLedgerAction} from './ledger-api.mjs';
const privateRoot=new URL('../../ledger_private/',import.meta.url),folder=new URL('real-trial/',privateRoot);
const read=async url=>{if((await fs.stat(url)).mode&0o077)throw Error('private_mode_required');return JSON.parse(await fs.readFile(url,'utf8'));};
export async function verifiedArchive(call,output){
  const handle=await fs.open(output,'wx',0o600);
  try{for await(const line of downloadBackup(call))await handle.writeFile(line+'\n');}finally{await handle.close();}
  const archive=await consumeBackup(readBackupLines(fileURLToPath(output))),rt=await runtime();
  try{
    const triggers=(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8')).split('\n-- statement\n').filter(s=>s.trim().startsWith('CREATE TRIGGER'));
    const restored=await restoreStream(rt.db,readBackupLines(fileURLToPath(output)),triggers);
    const restoredLines=downloadBackup((name,body)=>runLedgerAction(rt.db,'/api/'+name,body));
    const reread=await consumeBackup(restoredLines);
    if(restored.archive_hash!==archive.chain||reread.chain!==archive.chain)throw Error('backup_restore_readback_mismatch');
    return {verified:true,restore_readback_verified:true,snapshot:archive.snapshot,chain:archive.chain,sha256:createHash('sha256').update(await fs.readFile(output)).digest('hex'),file:fileURLToPath(output)};
  }finally{await rt.mf.dispose();}
}
export async function importReviews(call,plan){
  const before=await call('listIssues',{scope:'all'});
  if(before.revision!==plan.generation||before.data_source!=='real-copy'||before.total!==plan.tables.Issues.length-1)throw Error('trial_generation_required');
  if(plan.review_request.changes.length)await call('saveReviews',plan.review_request);
  for(const request of plan.issue_requests)await call('saveIssueReview',request);
  let verified=0;
  for(const row of plan.tables.Issues.slice(1)){
    const value=await call('listIssuePapers',{issue_key:row[0]});
    const expected=plan.review_request.changes.filter(c=>JSON.parse(row[4]).includes(c.pmid));
    if(value.revision!==plan.generation||value.total!==JSON.parse(row[4]).length)throw Error('trial_readback_mismatch');
    for(const c of expected){const saved=value.items.find(p=>p.pmid===c.pmid)?.review;if(!saved||saved.status!==c.status||saved.note!==c.note||saved.version!==1)throw Error('trial_review_readback_mismatch');verified++;}
    const issue=plan.issue_requests.find(r=>r.issue_key===row[0]);if(issue&&value.issue.status!==issue.status)throw Error('trial_issue_readback_mismatch');
    const detail=await call('getPaperDetail',{issue_key:row[0],pmid:JSON.parse(row[4])[0]});if(!detail.appearances.length)throw Error('trial_detail_missing');
  }
  return {verified:true,papers:plan.tables.Papers.length-1,issues:plan.tables.Issues.length-1,reviews_verified:verified,source_modified:false};
}
async function start(){
  await read(new URL('firebase-web.json',privateRoot));
  const config=await readLoginSettings(fileURLToPath(new URL('firebase-web.json',privateRoot)));
  const owner=await read(new URL('cloud-test-owner.json',privateRoot)),resources=await read(new URL('cloud-test-resources.json',privateRoot));
  if(config.ownerUid!==owner.ownerUid||config.firebase.projectId!==owner.projectId||!owner.ownerUid||resources.workerName!=='pmid-ledger-test')throw Error('fixed_test_owner_required');
  const origin=validateCloudOrigin(resources.origin),local='http://localhost:8791';
  const verifier=createOwnerVerifier(owner,{ownerKeys:createOwnerKeySource()});let busy=false;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const json=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
    try{
      if(req.headers.host!=='localhost:8791'||(req.headers.origin&&req.headers.origin!==local))return json({error:'origin_denied'},403);
      if(req.method==='GET'&&req.url==='/config')return json({firebase:config.firebase});
      const assets={'/':['trial-maintenance.html','text/html'],'/client.mjs':['trial-maintenance-client.mjs','text/javascript']};
      if(req.method==='GET'&&assets[req.url]){const [name,type]=assets[req.url];res.writeHead(200,{'Content-Type':type,'Content-Security-Policy':"default-src 'none'; script-src 'self' https://www.gstatic.com https://apis.google.com; connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com https://*.firebaseio.com https://securetoken.googleapis.com; frame-src https://*.firebaseapp.com https://accounts.google.com; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});return res.end(await fs.readFile(new URL(name,import.meta.url)));}
      if(req.method!=='POST'||!['/backup','/import-reviews'].includes(req.url)||req.headers.origin!==local||req.headers['content-type']!=='application/json')return json({error:'route_denied'},403);
      let size=0;for await(const part of req){size+=part.length;if(size>32)throw Error('request_too_large');}
      const authorization=req.headers.authorization;if(!authorization?.startsWith('Bearer '))return json({error:'identity_denied'},403);
      await verifier.verify(authorization.slice(7));if(busy)return json({error:'maintenance_busy'},409);busy=true;
      try{
        const call=async(name,body)=>{
          if(!['backupStart','backupPage','listIssues','listIssuePapers','getPaperDetail','saveReviews','saveIssueReview'].includes(name))throw Error('route_denied');
          const response=await fetch(origin+'/api/'+name,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',Authorization:authorization,'User-Agent':'PMIDLedgerTest/1.0'},body:JSON.stringify(body)});
          if(!response.ok)throw Error('test_request_failed');const result=await response.json();if(!Object.hasOwn(result,'value'))throw Error('invalid_response');return result.value;
        };
        let report;
        if(req.url==='/backup'){
          const output=new URL('test-backup-'+crypto.randomUUID()+'.ndjson',folder);
          report=await verifiedArchive(call,output);await fs.writeFile(new URL('backup-receipt.json',folder),JSON.stringify(report)+'\n',{mode:0o600});
          report={verified:true,restore_readback_verified:true,counts:report.snapshot.counts};
        }else{const plan=await read(new URL('plan.json',folder));report=await importReviews(call,plan);await fs.writeFile(new URL('owner-readback.json',folder),JSON.stringify(report)+'\n',{mode:0o600});}
        json(report);
      }finally{busy=false;}
    }catch{if(!res.headersSent)json({error:'maintenance_stopped_no_automatic_retry'},400);else res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8791,'127.0.0.1',resolve);});
  console.log('TESTバックアップ・実データコピー確認: http://localhost:8791/ （Google本人認証、token保存なし）');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
}
if(process.argv[1]===fileURLToPath(import.meta.url))start().catch(()=>{console.error('TEST保守画面を開始できません。設定・権限・ポートを確認してください。');process.exitCode=1;});
