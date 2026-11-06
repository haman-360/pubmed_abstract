import {Miniflare} from 'miniflare';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {backfillLists} from './worker.mjs';
import {manifestFor} from './chunked.mjs';
import {cloudOwnerPaths,validateCloudOrigin} from './cloud-login-proxy.mjs';

export function fixture(revised = false) {
  return JSON.parse(execFileSync('python3', ['-m', 'pmid_ledger.prototype.fixture', ...(revised ? ['--revised'] : [])],
    {cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', maxBuffer: 4000000}));
}
export async function runtime({persist = false, port = 0, local = true, now, identityFixture, identityKeyResponses, ownerLogin, cloudTest} = {}) {
  if(ownerLogin?.cloudOrigin)validateCloudOrigin(ownerLogin.cloudOrigin);
  let entry={scriptPath:fileURLToPath(new URL('./worker.mjs',import.meta.url))};
  if(identityFixture||ownerLogin||cloudTest){
    // Bundle the optional local JWT/login entry; normal npm start keeps its original entry.
    const {build}=await import('esbuild');
    const result=await build({entryPoints:[fileURLToPath(new URL(cloudTest?'./cloud-worker.mjs':ownerLogin?'./login-worker.mjs':'./identity-worker.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
    entry={script:result.outputFiles[0].text};
  }
  const mf = new Miniflare({modules: true, ...entry,
    compatibilityDate: '2026-07-30', host: '127.0.0.1', port, cf: false,
    d1Databases: {DB: 'local-synthetic-ledger'}, d1Persist: persist,
    serviceBindings:ownerLogin?{LOCAL_LOGIN_SETTINGS:async()=>{try{return new Response(JSON.stringify(await ownerLogin.settings()),{headers:{'Content-Type':'application/json'}});}catch{return new Response('',{status:503});}}}:{},
    bindings: {...(cloudTest?.bindings??{}),...(ownerLogin?{...(ownerLogin.cloudOrigin?{LOCAL_CLOUD_ORIGIN:ownerLogin.cloudOrigin}:{}),LOCAL_LOGIN_HTML:fs.readFileSync(new URL(ownerLogin.cloudOrigin?'./cloud-login.html':'./login.html',import.meta.url),'utf8'),LOCAL_LOGIN_CLIENT:fs.readFileSync(new URL(ownerLogin.cloudOrigin?'./cloud-login-client.mjs':'./login-client.mjs',import.meta.url),'utf8'),LOCAL_LOGIN_SDK:"export {initializeApp} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';export {initializeAuth,inMemoryPersistence,browserPopupRedirectResolver,GoogleAuthProvider,signInWithPopup,signOut,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';"}:{}),LOCAL_PROTOTYPE: local ? '1' : '0', ...(identityFixture?{LOCAL_IDENTITY_FIXTURE:JSON.stringify(identityFixture)}:{}), ...(now?{LOCAL_NOW:now}:{}), LOCAL_HTML: fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8'),
      LOCAL_METADATA:fs.readFileSync(new URL('./metadata.mjs',import.meta.url),'utf8'),
      LOCAL_BACKUP_CLIENT:fs.readFileSync(new URL('./backup-client.mjs',import.meta.url),'utf8')},
    // Deny outbound by default. Login permits Google public certs; the explicit cloud mode also permits fixed TEST owner routes.
    outboundService: request => {
      if(ownerLogin?.cloudOrigin&&request.method==='POST'&&new URL(request.url).origin===ownerLogin.cloudOrigin&&cloudOwnerPaths.has(new URL(request.url).pathname)){
        if(ownerLogin.cloudFetch)return ownerLogin.cloudFetch(request);
        return fetch(request.url,{method:'POST',headers:request.headers,body:request.body,duplex:'half',redirect:'manual',signal:AbortSignal.timeout(15000)});
      }
      if(cloudTest&&request.method==='GET'&&cloudTest.keyResponses&&[
        'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
        cloudTest.accessIssuer+'/cdn-cgi/access/certs'].includes(request.url))return cloudTest.keyResponses(request);
      // Tests inject public responses; the live diagnostic opts into the single official public-key URL.
      if(ownerLogin&&request.method==='GET'&&request.url==='https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'){
        if(ownerLogin.keyResponses)return ownerLogin.keyResponses(request);
        if(ownerLogin.googlePublicKeys)return fetch(request.url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(5000)});
      }
      const allowed=identityFixture?.remoteKeys&&request.method==='GET'&&[
        'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
        identityFixture.config.accessIssuer+'/cdn-cgi/access/certs'].includes(request.url);
      if(allowed&&identityKeyResponses)return identityKeyResponses(request);
      return new Response('Local prototype: outbound access disabled',{status:403});
    }});
  try {
    await mf.ready;
    const db = await mf.getD1Database('DB');
    const statements = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').split('\n-- statement\n');
    for (const sql of statements) await db.prepare(sql).run();
    await backfillLists(db);
    return {mf, db};
  } catch (e) { await mf.dispose(); throw e; }
}
export async function call(mf, name, body = {}, {sync = false, token, accessToken, fault, origin, profile = false} = {}) {
  const response = await mf.dispatchFetch('http://127.0.0.1/' + (sync ? 'sync/' : 'api/') + name, {
    method: 'POST', headers: {'Content-Type': 'application/json', ...(accessToken!==undefined?{'Cf-Access-Jwt-Assertion':accessToken}:{Authorization: token ?? (sync ? 'Bearer local-synthetic-sync' : 'Bearer local-synthetic-owner')}),
      ...(fault ? {'X-Local-Fault': fault} : {}), ...(origin ? {Origin: origin} : {}), ...(profile?{'X-Local-Profile':'1'}:{})}, body: JSON.stringify(body)});
  return {status: response.status, ...await response.json()};
}
export async function seed(mf, data = fixture(), expected_revision = null, {token,accessToken} = {}) {
  const {manifest,chunks}=await manifestFor(data.tables);
  const actions=[['begin',{synthetic:true,generation:data.generation,manifest}],
    ...chunks.map(c=>['chunk',{generation:data.generation,...c}]),
    ...Array.from({length:Math.ceil(manifest.tables.Issues.count/5)},(_,i)=>['build',{generation:data.generation,offset:i*5}]),
    ['finish',{generation:data.generation}],['publish',{generation:data.generation,expected_revision}]];
  for (const [name, body] of actions) {
    const result = await call(mf, name, body, {sync: true, token,accessToken});
    if (result.status !== 200) throw new Error(JSON.stringify(result));
  }
  return data;
}

// Initialization is internal to the local process; no unauthenticated seed HTTP route is exposed.
export async function seedDatabase(db,data=fixture()){
  const {default:worker}=await import('./worker.mjs');
  await seed({dispatchFetch:(url,options)=>worker.fetch(new Request(url,options),{LOCAL_PROTOTYPE:'1',DB:db})},data);
}
