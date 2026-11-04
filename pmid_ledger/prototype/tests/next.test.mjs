import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runtime,seed,call} from '../runtime.mjs';
import {exportBackup,restoreBackup,digestBackup,validateBackup} from '../backup-data.mjs';

const key='["synthetic-small","感染症"]';
const triggers=fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8').split('\n-- statement\n').filter(s=>s.trim().startsWith('CREATE TRIGGER'));
async function setup(t,seeded=true){const rt=await runtime();t.after(()=>rt.mf.dispose());if(seeded)await seed(rt.mf);return rt;}
async function save(mf,status='want_fulltext'){
  const {value}=await call(mf,'listIssuePapers',{issue_key:key});
  const r={operation_id:crypto.randomUUID(),review_operation_id:crypto.randomUUID(),revision:value.revision,issue_key:key,
    expected_version:value.issue.version,content_version:value.issue.content_version,
    changes:[{pmid:'1',expected_version:value.items[0].review.version,status,note:'=原本の架空メモ 🧪'}]};
  assert.equal((await call(mf,'saveAndCompleteIssue',r)).status,200);return r;
}

test('SQL list/search/save do not depend on full metadata JSON or summary transfer',async t=>{
  const {mf,db}=await setup(t);
  const expected=(await call(mf,'listIssuePapers',{issue_key:key})).value;
  await db.prepare("UPDATE generations SET tables_json='deliberately-unreadable-test-source'").run();
  assert.deepEqual((await call(mf,'listIssuePapers',{issue_key:key})).value,expected);
  assert.equal((await call(mf,'listIssues')).status,200);
  await save(mf);
  assert.equal((await call(mf,'listIssuePapers',{issue_key:key,query:'🧪'})).value.total,0);
  assert.equal((await call(mf,'listIssuePapers',{issue_key:key,query:"%' OR 1=1 --"})).value.total,0);
  const empty=(await call(mf,'listIssuePapers',{issue_key:key,query:'no-match',offset:500})).value;
  assert.equal(empty.total,0);assert.equal(empty.offset,0);assert.deepEqual(empty.items,[]);
});

test('JSON backup restores all generations, histories and retry IDs into a separate empty D1',async t=>{
  const source=await setup(t),target=await setup(t,false);
  const r=await save(source.mf);
  const backup=(await call(source.mf,'backup')).value;
  assert.equal((await call(source.mf,'backup',{}, {token:'Bearer local-synthetic-sync'})).status,403);
  await restoreBackup(target.db,backup,triggers);
  assert.deepEqual(await exportBackup(target.db),backup);
  const retry=await call(target.mf,'saveAndCompleteIssue',r);
  assert.equal(retry.status,200);assert.equal(retry.value.replayed,true);assert.equal(retry.value.completed,true);
  assert.deepEqual(await exportBackup(source.db),backup);
  const next=await save(target.mf,'read');
  assert.notEqual(next.operation_id,r.operation_id);
  assert.equal((await call(target.mf,'listIssuePapers',{issue_key:key})).value.items[0].review.version,2);
});

test('restore refuses occupied databases and checksum errors without changing their contents',async t=>{
  const source=await setup(t),target=await setup(t);
  await save(source.mf);const backup=await exportBackup(source.db),before=await exportBackup(target.db);
  await assert.rejects(()=>restoreBackup(target.db,backup,triggers));
  assert.deepEqual(await exportBackup(target.db),before);
  const corrupt=structuredClone(backup);corrupt.payload.tables.review_current[0][3]='tampered';
  await assert.rejects(()=>restoreBackup(target.db,corrupt,triggers),/checksum/);
  assert.deepEqual(await exportBackup(target.db),before);
});

test('restore validates history and operation integrity even when a damaged file has a fresh checksum',async t=>{
  const source=await setup(t);await save(source.mf);const original=await exportBackup(source.db);
  for(const mutate of [p=>p.tables.review_events[0][2]=3,p=>p.tables.review_current[0][3]='changed',
    p=>p.tables.operation_ids.pop(),p=>p.tables.operations[0][1]='bad-hash',p=>p.tables.generations[0][2]='{}']){
    const copy=structuredClone(original);mutate(copy.payload);copy.sha256=await digestBackup(copy.payload);
    await assert.rejects(()=>validateBackup(copy));
  }
});

test('failure after restore writes rolls back rows and DDL, leaving an empty usable target',async t=>{
  const source=await setup(t),target=await setup(t,false);
  const r=await save(source.mf),backup=await exportBackup(source.db),before=await exportBackup(target.db);
  await assert.rejects(()=>restoreBackup(target.db,backup,triggers,{simulateFailure:true}));
  assert.deepEqual(await exportBackup(target.db),before);
  await restoreBackup(target.db,backup,triggers);
  assert.equal((await call(target.mf,'saveAndCompleteIssue',r)).value.replayed,true);
});

test('startup backfills only missing list projections and preserves saved notes and old states',async t=>{
  const {mf,db}=await setup(t);await save(mf,'read');
  const before=await exportBackup(db);
  await db.prepare('DELETE FROM issue_lists').run();
  const {backfillLists}=await import('../worker.mjs');await backfillLists(db);
  assert.deepEqual(await exportBackup(db),before);
  assert.equal((await call(mf,'listIssuePapers',{issue_key:key})).value.items[0].review.status,'read');
});
