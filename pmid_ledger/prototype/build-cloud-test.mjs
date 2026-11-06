// Offline bundle preparation only. Never creates resources or uploads/deploys code.
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {onlineAssets} from './online-build.mjs';
let define={};
if(process.argv.slice(2).some(arg=>arg!=='--with-online-app'))throw Error('unsupported_build_argument');
if(process.argv.includes('--with-online-app')){
  const file=new URL('../../ledger_private/firebase-web.json',import.meta.url);
  if((await fs.stat(file)).mode&0o077)throw Error('private_web_settings_mode_required');
  const input=JSON.parse(await fs.readFile(file,'utf8'));
  const owner=JSON.parse(await fs.readFile(new URL('../../ledger_private/cloud-test-owner.json',import.meta.url),'utf8'));
  if(input.firebase?.projectId!==owner.projectId||input.ownerUid!==owner.ownerUid||!owner.ownerUid)throw Error('fixed_test_owner_required');
  define={__LEDGER_APP_ASSETS__:JSON.stringify(await onlineAssets(input.firebase))};
}
const result=await build({entryPoints:[fileURLToPath(new URL('./cloud-worker.mjs',import.meta.url))],bundle:true,write:false,
  format:'esm',platform:'browser',target:'es2022',metafile:true,define});
const inputs=Object.keys(result.metafile.inputs),code=result.outputFiles[0].text;
if(inputs.some(p=>/(?:^|\/)(?:worker|runtime|identity-worker|login-worker)\.mjs$/.test(p))||
  /local-synthetic-(owner|sync)|X-Local-Fault|LOCAL_IDENTITY_FIXTURE|LOCAL_PREVIEW_ONLY|local_response_lost_retry_same_request|drop-response/.test(code))throw new Error('local_entry_in_cloud_bundle');
await fs.mkdir(new URL('./.cloud-test/',import.meta.url),{recursive:true});
await fs.writeFile(new URL('./.cloud-test/worker.mjs',import.meta.url),code,{mode:0o600});
console.log(JSON.stringify({prepared:true,uploaded:false,online_app:!!define.__LEDGER_APP_ASSETS__,bytes:Buffer.byteLength(code),modules:inputs.length}));
