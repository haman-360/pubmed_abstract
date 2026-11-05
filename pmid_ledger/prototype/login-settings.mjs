import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
export function validateLoginSettings(input){
  const f=input?.firebase;
  if(!f||!/^AIza[A-Za-z0-9_-]{35}$/.test(f.apiKey??'')||!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(f.projectId??'')
    ||f.authDomain!==f.projectId+'.firebaseapp.com'||!/^\d+:\d+:web:[a-f0-9]+$/.test(f.appId??''))throw new Error('Firebase Web設定を確認してください。');
  const uid=input.ownerUid??null;
  if(uid!==null&&(typeof uid!=='string'||uid.length<1||uid.length>128||/[\x00-\x1f]/.test(uid)))throw new Error('本人UIDを確認してください。');
  return {firebase:{apiKey:f.apiKey,authDomain:f.authDomain,projectId:f.projectId,appId:f.appId},ownerUid:uid};
}
export async function readLoginSettings(file){return validateLoginSettings(JSON.parse(await fs.readFile(file,'utf8')));}
export async function pinOwner(file,uid){
  const current=await readLoginSettings(file),next=validateLoginSettings({...current,ownerUid:uid});
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temporary,file);}
  finally{await fs.rm(temporary,{force:true});}
}
