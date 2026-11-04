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
export async function runtime({persist = false, port = 0, local = true} = {}) {
  const mf = new Miniflare({modules: true, scriptPath: fileURLToPath(new URL('./worker.mjs', import.meta.url)),
    compatibilityDate: '2026-07-30', host: '127.0.0.1', port, cf: false,
    d1Databases: {DB: 'local-synthetic-ledger'}, d1Persist: persist,
    bindings: {LOCAL_PROTOTYPE: local ? '1' : '0', LOCAL_HTML: fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8'),
      LOCAL_METADATA:fs.readFileSync(new URL('./metadata.mjs',import.meta.url),'utf8'),
      LOCAL_BACKUP_CLIENT:fs.readFileSync(new URL('./backup-client.mjs',import.meta.url),'utf8')},
    // Deny outbound HTTP from the Worker, including accidental future fetch() additions.
    outboundService: () => new Response('Local prototype: outbound access disabled', {status: 403})});
  try {
    await mf.ready;
    const db = await mf.getD1Database('DB');
    const statements = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').split('\n-- statement\n');
    for (const sql of statements) await db.prepare(sql).run();
    await backfillLists(db);
    return {mf, db};
  } catch (e) { await mf.dispose(); throw e; }
}
export async function call(mf, name, body = {}, {sync = false, token, fault, origin, profile = false} = {}) {
  const response = await mf.dispatchFetch('http://127.0.0.1/' + (sync ? 'sync/' : 'api/') + name, {
    method: 'POST', headers: {'Content-Type': 'application/json', Authorization: token ?? (sync ? 'Bearer local-synthetic-sync' : 'Bearer local-synthetic-owner'),
      ...(fault ? {'X-Local-Fault': fault} : {}), ...(origin ? {Origin: origin} : {}), ...(profile?{'X-Local-Profile':'1'}:{})}, body: JSON.stringify(body)});
  return {status: response.status, ...await response.json()};
}
export async function seed(mf, data = fixture(), expected_revision = null) {
  const {manifest,chunks}=await manifestFor(data.tables);
  const actions=[['begin',{synthetic:true,generation:data.generation,manifest}],
    ...chunks.map(c=>['chunk',{generation:data.generation,...c}]),
    ...Array.from({length:Math.ceil(manifest.tables.Issues.count/5)},(_,i)=>['build',{generation:data.generation,offset:i*5}]),
    ['finish',{generation:data.generation}],['publish',{generation:data.generation,expected_revision}]];
  for (const [name, body] of actions) {
    const result = await call(mf, name, body, {sync: true});
    if (result.status !== 200) throw new Error(JSON.stringify(result));
  }
  return data;
}
