import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runtime,fixture,seed,call} from '../runtime.mjs';
import {manifestFor} from '../chunked.mjs';
import {downloadBackup,consumeBackup} from '../backup-client.mjs';
import {restoreStream} from '../restore-stream.mjs';
import {exportBackup,restoreBackup} from '../backup-data.mjs';
import {readBackupLines} from '../backup-file.mjs';
import {backfillLists} from '../worker.mjs';
const triggers=fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8').split('\n-- statement\n').filter(s=>s.trim().startsWith('CREATE TRIGGER'));
const key='["synthetic-small","感染症"]';
async function setup(t,seeded=false){const e=await runtime();t.after(()=>e.mf.dispose());if(seeded)await seed(e.mf);return e;}
async function sync(mf,name,body){return call(mf,name,body,{sync:true});}
async function plan(data=fixture()){return {...await manifestFor(data.tables),generation:data.generation};}
async function uploadPlan(mf,p){
  assert.equal((await sync(mf,'begin',{synthetic:true,generation:p.generation,manifest:p.manifest})).status,200);
  for(const c of p.chunks)assert.equal((await sync(mf,'chunk',{generation:p.generation,...c})).status,200);
  for(let offset=0;offset<p.manifest.tables.Issues.count;offset+=5)assert.equal((await sync(mf,'build',{generation:p.generation,offset})).status,200);
}
async function archive(mf,intercept){
  const lines=[];for await(const line of downloadBackup(async(name,body)=>{if(intercept)await intercept(name,body);const r=await call(mf,name,body);assert.equal(r.status,200);return r.value;}))lines.push(line);return lines;
}
async function classify(mf){const loaded=(await call(mf,'listIssuePapers',{issue_key:key})).value;
  const r={operation_id:crypto.randomUUID(),review_operation_id:crypto.randomUUID(),revision:loaded.revision,issue_key:key,expected_version:0,content_version:loaded.issue.content_version,
    changes:[{pmid:'1',expected_version:0,status:'want_fulltext',note:'snapshot note'}]};assert.equal((await call(mf,'saveAndCompleteIssue',r)).status,200);return r;}

test('batched detail preserves shared appearances, ordered text parts and rejects missing parts',async t=>{
  const {mf,db}=await setup(t,true);
  const all=await call(mf,'getPaperDetail',{pmid:'1'});assert.equal(all.status,200);assert.equal(all.value.appearances.length,3);
  const scoped=await call(mf,'getPaperDetail',{pmid:'1',issue_key:key});assert.equal(scoped.status,200);assert.equal(scoped.value.appearances.length,1);
  assert.deepEqual(scoped.value.appearances,all.value.appearances.filter(a=>JSON.stringify([a.issue_id,a.topic])===key));
  assert.equal(scoped.value.appearances[0].text.summary_ja,'架空本文🧪'.repeat(5000));
  await db.prepare("DELETE FROM metadata_records WHERE table_name='Texts' AND json_extract(row_json,'$[1]')='0'").run();
  assert.equal((await call(mf,'getPaperDetail',{pmid:'1',issue_key:key})).status,409);
});

test('chunks remain private until complete and checked; duplicates replay and mismatches are refused',async t=>{
  const {mf,db}=await setup(t),p=await plan();
  assert.equal((await sync(mf,'begin',{synthetic:true,generation:p.generation,manifest:p.manifest})).status,200);
  assert.equal((await sync(mf,'publish',{generation:p.generation,expected_revision:null})).status,409);
  assert.equal((await sync(mf,'finish',{generation:p.generation})).status,409);
  const body={generation:p.generation,...p.chunks[0]};assert.equal((await sync(mf,'chunk',body)).status,200);
  assert.equal((await sync(mf,'chunk',body)).value.replayed,true);
  const damaged=structuredClone(body);damaged.rows[0][1]+='x';assert.notEqual((await sync(mf,'chunk',damaged)).status,200);
  assert.equal((await db.prepare('SELECT count(*) n FROM metadata_chunks').first()).n,1);
  await uploadPlan(mf,p);assert.equal((await sync(mf,'finish',{generation:p.generation})).status,200);
  assert.equal((await sync(mf,'publish',{generation:p.generation,expected_revision:null})).status,200);
  const stored=(await db.prepare('SELECT tables_json FROM generations').first()).tables_json;
  assert(stored.length<20000);assert(!stored.includes('summary_ja'));
  assert.equal((await call(mf,'getPaperDetail',{pmid:'1',issue_key:key})).status,200);
});

test('a failed out-of-order chunk rolls back its registration and records, then retries cleanly',async t=>{
  const {mf,db}=await setup(t),p=await plan();
  await sync(mf,'begin',{synthetic:true,generation:p.generation,manifest:p.manifest});
  const c=p.chunks.find(c=>c.table_name==='Issues');assert.notEqual((await sync(mf,'chunk',{generation:p.generation,...c})).status,200);
  assert.equal((await db.prepare("SELECT count(*) n FROM metadata_chunks WHERE table_name='Issues'").first()).n,0);
  await uploadPlan(mf,p);assert.equal((await sync(mf,'finish',{generation:p.generation})).status,200);
});

test('startup backfill skips unfinished source uploads so synchronization can resume',async t=>{
  const {mf,db}=await setup(t),p=await plan();
  await sync(mf,'begin',{synthetic:true,generation:p.generation,manifest:p.manifest});
  for(const name of ['Papers','Issues'])for(const c of p.chunks.filter(c=>c.table_name===name))
    assert.equal((await sync(mf,'chunk',{generation:p.generation,...c})).status,200);
  await backfillLists(db);
  assert.equal((await db.prepare('SELECT count(*) n FROM issue_lists').first()).n,0);
  await uploadPlan(mf,p);assert.equal((await sync(mf,'finish',{generation:p.generation})).status,200);
  assert.equal((await sync(mf,'publish',{generation:p.generation,expected_revision:null})).status,200);
});

test('missing text parts cannot seal a generation even with self-consistent transfer hashes',async t=>{
  const {mf,db}=await setup(t),data=fixture();data.tables.Texts.find(r=>r[1]==='1')[1]='3';
  const p=await plan(data);await uploadPlan(mf,p);
  assert.equal((await sync(mf,'finish',{generation:p.generation})).status,409);
  assert.equal((await db.prepare('SELECT count(*) n FROM generation_ready').first()).n,0);
});

test('paged backup is a fixed snapshot while later edits continue; restore reconstructs the original state',async t=>{
  const source=await setup(t,true),target=await setup(t),r=await classify(source.mf);let edited=false;
  const lines=await archive(source.mf,async(name)=>{
    if(name==='backupPage'&&!edited){edited=true;await call(source.mf,'saveReviews',{operation_id:crypto.randomUUID(),revision:r.revision,
      changes:[{pmid:'1',expected_version:1,status:'read',note:'later note'}]});}
  });
  const original=await consumeBackup(lines);
  const restored=await restoreStream(target.db,lines,triggers);assert.equal(restored.archive_hash,original.chain);
  const state=(await call(target.mf,'listIssuePapers',{issue_key:key})).value.items[0].review;
  assert.equal(state.version,1);assert.equal(state.note,'snapshot note');
  assert.equal((await call(source.mf,'listIssuePapers',{issue_key:key})).value.items[0].review.version,2);
  const replay=await call(target.mf,'saveAndCompleteIssue',r);assert.equal(replay.value.replayed,true);
  assert.equal((await consumeBackup(await archive(target.mf))).chain,original.chain);
  assert.deepEqual((await call(target.mf,'getPaperDetail',{pmid:'1',issue_key:key})).value,(await call(source.mf,'getPaperDetail',{pmid:'1',issue_key:key})).value);
});

test('truncated or corrupted paged backups never publish a partial restore and occupied targets are refused',async t=>{
  const source=await setup(t,true),lines=await archive(source.mf);
  for(const broken of [lines.slice(0,-1),lines.map((line,i)=>i===1?line.replace('"sha256":"','"sha256":"wrong'):line)]){
    const target=await setup(t);await assert.rejects(()=>restoreStream(target.db,broken,triggers));
    assert.equal((await target.db.prepare('SELECT generation FROM settings').first()).generation,null);
  }
  const before=await exportBackup(source.db);await assert.rejects(()=>restoreStream(source.db,lines,triggers));
  assert.deepEqual(await exportBackup(source.db),before);
});

test('legacy V1 JSON and legacy metadata generations still restore and display details',async t=>{
  const source=await setup(t),target=await setup(t),data=fixture();
  assert.equal((await sync(source.mf,'stage',data)).status,200);await sync(source.mf,'publish',{generation:data.generation,expected_revision:null});
  await classify(source.mf);
  const v1=await exportBackup(source.db,{format:'LOCAL_SYNTHETIC_D1_BACKUP_V1'});
  await restoreBackup(target.db,v1,triggers);
  assert.equal((await call(target.mf,'getPaperDetail',{pmid:'1',issue_key:key})).status,200);
  assert.equal((await call(target.mf,'listIssuePapers',{issue_key:key})).value.items[0].review.note,'snapshot note');
  const streamTarget=await setup(t);await restoreStream(streamTarget.db,await archive(source.mf),triggers);
  assert.equal((await call(streamTarget.mf,'getPaperDetail',{pmid:'1',issue_key:key})).status,200);
});

test('file-based streamed restore reads the header after asynchronous database setup',async t=>{
  const source=await setup(t,true),target=await setup(t),directory=await mkdtemp(join(tmpdir(),'pmid-stream-file-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await classify(source.mf);const file=join(directory,'synthetic.ndjson');await writeFile(file,(await archive(source.mf)).join('\n')+'\n',{mode:0o600});
  await restoreStream(target.db,readBackupLines(file),triggers);
  assert.equal((await call(target.mf,'listIssuePapers',{issue_key:key})).value.items[0].review.note,'snapshot note');
});

test('paged backup retains completed generations and excludes unfinished uploads',async t=>{
  const source=await setup(t,true),target=await setup(t),first=fixture(),revised=fixture(true);
  await classify(source.mf);await seed(source.mf,revised,first.generation);
  const unfinished='f'.repeat(64),p=await plan();
  await sync(source.mf,'begin',{synthetic:true,generation:unfinished,manifest:p.manifest});
  await sync(source.mf,'chunk',{generation:unfinished,...p.chunks[0]});
  const lines=await archive(source.mf),before=await consumeBackup(lines);
  assert.deepEqual(before.snapshot.generations,[first.generation,revised.generation].sort());
  await restoreStream(target.db,lines,triggers);
  assert.equal((await consumeBackup(await archive(target.mf))).chain,before.chain);
  assert.equal((await target.db.prepare('SELECT generation FROM settings').first()).generation,revised.generation);
  assert.equal((await target.db.prepare('SELECT count(*) n FROM generations').first()).n,2);
  assert.equal((await call(target.mf,'listIssuePapers',{issue_key:key})).value.items[0].review.note,'snapshot note');
});

test('metadata backup pages walk a rowid cursor without repeated full-table scans',async t=>{
  const {mf,db}=await setup(t,true);let reads=0;
  await consumeBackup(downloadBackup(async(name,body)=>{
    const r=await call(mf,name,body,{profile:true});assert.equal(r.status,200);
    if(name==='backupPage'&&body.table==='metadata_records')reads+=r.profile.rows_read;
    return r.value;
  }));
  const rows=(await db.prepare('SELECT count(*) n FROM metadata_records').first()).n;
  assert(reads<=rows*4+128,`${reads} reads for ${rows} source records`);
});
