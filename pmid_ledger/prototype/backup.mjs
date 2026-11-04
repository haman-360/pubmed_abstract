import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtime} from './runtime.mjs';
import {restoreBackup,validateBackup} from './backup-data.mjs';

const root=fileURLToPath(new URL('./',import.meta.url));
const [action,input]=process.argv.slice(2);
if(action==='export'){
  const response=await fetch('http://127.0.0.1:8787/api/backup',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer local-synthetic-owner'},body:'{}',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error(`Local backup failed: HTTP ${response.status}`);
  const {value}=await response.json();await validateBackup(value);
  const folder=path.join(root,'.backups');await fs.mkdir(folder,{recursive:true});
  const output=path.join(folder,`${crypto.randomUUID()}.json`);
  await fs.writeFile(output,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});console.log(output);
}else if(action==='restore'&&input){
  const backup=JSON.parse(await fs.readFile(input,'utf8'));await validateBackup(backup);
  const folder=path.join(root,'.restored-d1',crypto.randomUUID());await fs.mkdir(folder,{recursive:true});
  let rt;
  try{
    rt=await runtime({persist:folder});
    const sql=await fs.readFile(path.join(root,'schema.sql'),'utf8');
    const triggers=sql.split('\n-- statement\n').filter(s=>s.trim().startsWith('CREATE TRIGGER'));
    await restoreBackup(rt.db,backup,triggers);
    console.log(`復元・読み戻し一致: ${folder}\n起動: node local.mjs --restored ${path.basename(folder)}`);
  }catch(e){await rt?.mf.dispose();rt=null;await fs.rm(folder,{recursive:true,force:true});throw e;}
  finally{await rt?.mf.dispose();}
}else{console.error('Usage: node backup.mjs export | node backup.mjs restore <backup.json>');process.exitCode=1;}
