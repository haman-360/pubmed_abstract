// Mac launcher: loopback Google login -> read-only owner API -> private TXT.
import http from 'node:http';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {readLoginSettings} from './login-settings.mjs';
import {createOwnerVerifier} from './identity.mjs';
import {createOwnerKeySource} from './identity-keys.mjs';
import {validateCloudOrigin} from './cloud-login-proxy.mjs';

export async function collectWanted(call){
  const ids=new Set();let after='',cutoff;
  while(true){
    const page=await call({after,...(cutoff===undefined?{}:{cutoff})});
    if(!Number.isSafeInteger(page.cutoff)||page.cutoff<0||(cutoff!==undefined&&cutoff!==page.cutoff)||
      !Array.isArray(page.pmids)||page.pmids.length>500||typeof page.done!=='boolean')throw Error('invalid_export_page');
    cutoff=page.cutoff;
    for(const id of page.pmids){
      if(typeof id!=='string'||!(/^[1-9][0-9]{0,8}$/).test(id)||id<=after||ids.has(id))throw Error('invalid_export_pmid');
      ids.add(id);after=id;
    }
    if(page.after!==after||(!page.done&&!page.pmids.length)||ids.size>100000)throw Error('invalid_export_cursor');
    if(page.done)break;
  }
  const sorted=[...ids].sort((a,b)=>Number(a)-Number(b));
  return {count:sorted.length,text:sorted.length?sorted.join('\n')+'\n':''};
}

export async function saveWanted(result,directory){
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const stamp=new Date().toISOString().replaceAll(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const output=new URL(`pmids-${stamp}-${crypto.randomUUID().slice(0,8)}.txt`,directory);
  const handle=await fs.open(output,'wx',0o600);
  try{await handle.writeFile(result.text,'utf8');}
  catch(e){await handle.close();await fs.unlink(output);throw e;}
  await handle.close();return fileURLToPath(output);
}

export async function startExport({open=path=>execFile('open',[path],()=>{})}={}){
  const root=new URL('../../ledger_private/',import.meta.url);
  if((await fs.stat(new URL('firebase-web.json',root))).mode&0o077)throw Error('private_settings_required');
  const config=await readLoginSettings(fileURLToPath(new URL('firebase-web.json',root)));
  const privateJson=async name=>{
    const path=new URL(name,root);if((await fs.stat(path)).mode&0o077)throw Error('private_settings_required');
    return JSON.parse(await fs.readFile(path,'utf8'));
  };
  const owner=await privateJson('cloud-test-owner.json'),resources=await privateJson('cloud-test-resources.json');
  if(!owner.ownerUid||config.ownerUid!==owner.ownerUid||config.firebase.projectId!==owner.projectId||resources.workerName!=='pmid-ledger-test')throw Error('fixed_test_owner_required');
  const origin=validateCloudOrigin(resources.origin),local='http://localhost:8792';
  const verifier=createOwnerVerifier(owner,{ownerKeys:createOwnerKeySource()});let busy=false,finished=false;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const json=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
    try{
      if(req.headers.host!=='localhost:8792'||(req.headers.origin&&req.headers.origin!==local))return json({error:'origin_denied'},403);
      if(req.method==='GET'&&req.url==='/config')return json({firebase:config.firebase});
      if(req.method==='GET'&&['/','/client.mjs'].includes(req.url)){
        res.writeHead(200,{'Content-Type':req.url==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8',
          'Content-Security-Policy':"default-src 'none'; script-src 'self' https://www.gstatic.com https://apis.google.com; connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com https://*.firebaseio.com; frame-src https://*.firebaseapp.com https://accounts.google.com https://*.google.com; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});
        return res.end(await fs.readFile(new URL(req.url==='/'?'export-wanted.html':'export-wanted-client.mjs',import.meta.url)));
      }
      if(req.method!=='POST'||req.url!=='/export'||req.headers.origin!==local||req.headers['content-type']!=='application/json')return json({error:'route_denied'},403);
      let body='';for await(const part of req){body+=part.toString();if(body.length>32)throw Error('request_too_large');}
      if(body!=='{}')return json({error:'empty_request_required'},400);
      const auth=req.headers.authorization;if(!auth?.startsWith('Bearer '))return json({error:'identity_denied'},403);
      try{await verifier.verify(auth.slice(7));}catch{return json({error:'identity_denied'},403);}
      if(busy||finished)return json({error:'export_busy_or_finished'},409);busy=true;
      try{
        const result=await collectWanted(async value=>{
          const response=await fetch(origin+'/api/wantedPmids',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
            headers:{'Content-Type':'application/json',Authorization:auth,'User-Agent':'PMIDLedgerTest/1.0'},body:JSON.stringify(value)});
          if(!response.ok)throw Error(response.status===409?'export_changed_restart':'export_api_unavailable');
          return (await response.json()).value;
        });
        const path=await saveWanted(result,new URL('exports/',root));finished=true;
        console.log(`希望PMID ${result.count}件を保存しました: ${path}`);
        json({count:result.count,path});open(path.slice(0,path.lastIndexOf('/')));
        clearTimeout(expiry);setTimeout(()=>server.close(),2000).unref();
      }finally{busy=false;}
    }catch(e){if(!res.headersSent)json({error:e.message==='export_changed_restart'?'export_changed_restart':'export_stopped_no_file_saved'},400);else res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8792,'127.0.0.1',resolve);});
  const expiry=setTimeout(()=>server.close(),15*60*1000);expiry.unref();server.on('close',()=>clearTimeout(expiry));
  console.log(`希望PMIDの出力: ${local}/ （Google本人認証・読み取りのみ）`);open(local+'/');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
  return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url))startExport().catch(()=>{console.error('PMID出力を開始できません。Node.js 22以降・台帳のローカル設定・8792番ポートを確認してください。');process.exitCode=1;});
