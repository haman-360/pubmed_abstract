// Offline bundle preparation only. Never creates resources or uploads/deploys code.
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const result=await build({entryPoints:[fileURLToPath(new URL('./cloud-worker.mjs',import.meta.url))],bundle:true,write:false,
  format:'esm',platform:'browser',target:'es2022',metafile:true});
const inputs=Object.keys(result.metafile.inputs),code=result.outputFiles[0].text;
if(inputs.some(p=>/(?:^|\/)(?:worker|runtime|identity-worker|login-worker)\.mjs$/.test(p))||
  /local-synthetic-(owner|sync)|X-Local-Fault|LOCAL_IDENTITY_FIXTURE|local_response_lost_retry_same_request|drop-response/.test(code))throw new Error('local_entry_in_cloud_bundle');
await fs.mkdir(new URL('./.cloud-test/',import.meta.url),{recursive:true});
await fs.writeFile(new URL('./.cloud-test/worker.mjs',import.meta.url),code,{mode:0o600});
console.log(JSON.stringify({prepared:true,uploaded:false,bytes:Buffer.byteLength(code),modules:inputs.length}));
