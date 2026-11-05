import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {runtime,seedDatabase} from './runtime.mjs';
import {readLoginSettings,pinOwner} from './login-settings.mjs';
const configFile=fileURLToPath(new URL('../../ledger_private/firebase-web.json',import.meta.url));
if(process.argv[2]==='--owner'&&process.argv.length===4){
  await pinOwner(configFile,process.argv[3]);console.log('本人UIDをローカル設定へ保存しました。ログイン確認画面で「認証を再確認」を押してください。');
}else if(process.argv.length===2){
  await readLoginSettings(configFile);
  const rt=await runtime({persist:fileURLToPath(new URL('./.login-d1/',import.meta.url)),port:8788,ownerLogin:{settings:()=>readLoginSettings(configFile),googlePublicKeys:true}});
  try{if(!(await rt.db.prepare('SELECT generation FROM settings WHERE id=1').first()).generation)await seedDatabase(rt.db);}
  catch(e){await rt.mf.dispose();throw e;}
  console.log('Googleログイン確認: http://localhost:8788 （架空データ・追加費用0円）');
  console.log('Googleログイン時のみFirebaseへ接続し、サーバーはGoogle公式公開鍵だけを取得します。停止: Ctrl+C。');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await rt.mf.dispose();process.exit(0);});
}else{console.error('Usage: node login-local.mjs [--owner <verified-uid>]');process.exitCode=1;}
