import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtime} from './runtime.mjs';
import {restoreBackup,validateBackup} from './backup-data.mjs';
import {downloadBackup,consumeBackup} from './backup-client.mjs';
import {restoreStream} from './restore-stream.mjs';
import {readBackupLines} from './backup-file.mjs';

const root=fileURLToPath(new URL('./',import.meta.url));
const [action,input]=process.argv.slice(2);
if(action==='export'){
  const folder=path.join(root,'.backups');await fs.mkdir(folder,{recursive:true});
  const output=path.join(folder,`${crypto.randomUUID()}.ndjson`),handle=await fs.open(output,'wx',0o600);
  try{
    const call=async(name,body)=>{const response=await fetch('http://127.0.0.1:8787/api/'+name,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer local-synthetic-owner'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error(`Local backup failed: HTTP ${response.status}`);return (await response.json()).value;};
    for await(const line of downloadBackup(call))await handle.writeFile(line+'\n');await handle.close();
    await consumeBackup(readBackupLines(output));console.log(output);
  }catch(e){await handle.close().catch(()=>{});await fs.rm(output,{force:true});throw e;}
}else if(action==='restore'&&input){
  const reader=await fs.open(input,'r'),prefix=Buffer.alloc(64);await reader.read(prefix,0,64,0);await reader.close();
  const streaming=prefix.toString('utf8').startsWith('{"type":"header"');
  let backup=null;
  if(!streaming){if((await fs.stat(input)).size>8000000)throw new Error('Unsupported legacy backup size');backup=JSON.parse(await fs.readFile(input,'utf8'));await validateBackup(backup);}
  const folder=path.join(root,'.restored-d1',crypto.randomUUID());await fs.mkdir(folder,{recursive:true});
  let rt;
  try{
    rt=await runtime({persist:folder});
    const sql=await fs.readFile(path.join(root,'schema.sql'),'utf8');
    const triggers=sql.split('\n-- statement\n').filter(s=>s.trim().startsWith('CREATE TRIGGER'));
    if(streaming)await restoreStream(rt.db,readBackupLines(input),triggers);
    else await restoreBackup(rt.db,backup,triggers);
    console.log(`復元・読み戻し一致: ${folder}\n起動: node local.mjs --restored ${path.basename(folder)}`);
  }catch(e){await rt?.mf.dispose();rt=null;await fs.rm(folder,{recursive:true,force:true});throw e;}
  finally{await rt?.mf.dispose();}
}else{console.error('Usage: node backup.mjs export | node backup.mjs restore <backup.ndjson|backup.json>');process.exitCode=1;}
