import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {runtime} from './runtime.mjs';
import {readLoginSettings} from './login-settings.mjs';
import {validateCloudOrigin} from './cloud-login-proxy.mjs';
const privateRoot=new URL('../../ledger_private/',import.meta.url);
export async function cloudLoginSettings(){
  const read=async name=>{const path=new URL(name,privateRoot);if((await fs.stat(path)).mode&0o077)throw Error('private_mode_required');return JSON.parse(await fs.readFile(path,'utf8'));};
  const resources=await read('cloud-test-resources.json'),owner=await read('cloud-test-owner.json');
  const settings=await readLoginSettings(fileURLToPath(new URL('firebase-web.json',privateRoot)));
  if((await fs.stat(new URL('firebase-web.json',privateRoot))).mode&0o077)throw Error('private_mode_required');
  if(resources.workerName!=='pmid-ledger-test'||settings.firebase.projectId!==owner.projectId||settings.ownerUid!==owner.ownerUid||!owner.ownerUid)throw Error('fixed_test_owner_required');
  const verification=JSON.parse(await fs.readFile(new URL('./.cloud-test/sync-verification.json',import.meta.url),'utf8'));
  if(verification.full_readback_verified!==true||verification.papers!==120)throw Error('verified_synthetic_sync_required');
  return {settings,origin:validateCloudOrigin(resources.origin)};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==2)throw Error('arguments_not_supported');
    const {origin}=await cloudLoginSettings();
    const rt=await runtime({port:8789,ownerLogin:{settings:async()=>(await cloudLoginSettings()).settings,googlePublicKeys:true,cloudOrigin:origin}});
    console.log('クラウドTEST保存確認: http://localhost:8789 （架空データ専用・追加費用0円）');
    console.log('認証情報はメモリだけで扱います。停止: Ctrl+C。');
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await rt.mf.dispose();process.exit(0);});
  }catch{console.error('TEST接続・Firebase設定・固定本人UID・120件の同期結果を確認してください。');process.exitCode=1;}
}
