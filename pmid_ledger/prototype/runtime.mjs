import {Miniflare} from 'miniflare';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {backfillLists} from './worker.mjs';
import {manifestFor} from './chunked.mjs';

export function fixture(revised = false) {
  return JSON.parse(execFileSync('python3', ['-m', 'pmid_ledger.prototype.fixture', ...(revised ? ['--revised'] : [])],
    {cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', maxBuffer: 4000000}));
}
export async function runtime({persist = false, port = 0, local = true, now, identityFixture, identityKeyResponses} = {}) {
  let entry={scriptPath:fileURLToPath(new URL('./worker.mjs',import.meta.url))};
  if(identityFixture){
    // Bundle only the JWT test entry; normal npm start and its data are unchanged.
    const {build}=await import('esbuild');
    const result=await build({entryPoints:[fileURLToPath(new URL('./identity-worker.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
    entry={script:result.outputFiles[0].text};
  }
  const mf = new Miniflare({modules: true, ...entry,
    compatibilityDate: '2026-07-30', host: '127.0.0.1', port, cf: false,
    d1Databases: {DB: 'local-synthetic-ledger'}, d1Persist: persist,
    bindings: {LOCAL_PROTOTYPE: local ? '1' : '0', ...(identityFixture?{LOCAL_IDENTITY_FIXTURE:JSON.stringify(identityFixture)}:{}), ...(now?{LOCAL_NOW:now}:{}), LOCAL_HTML: fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8'),
      LOCAL_METADATA:fs.readFileSync(new URL('./metadata.mjs',import.meta.url),'utf8'),
      LOCAL_BACKUP_CLIENT:fs.readFileSync(new URL('./backup-client.mjs',import.meta.url),'utf8')},
    // Deny outbound HTTP from the Worker, including accidental future fetch() additions.
    outboundService: request => {
      // Only tests can supply these in-memory public responses; no real outbound fetch is performed here.
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
