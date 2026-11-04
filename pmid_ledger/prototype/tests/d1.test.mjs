import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, fixture, seed, call} from '../runtime.mjs';
import {environment} from '../../tests/environment.mjs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const main = '["synthetic-main","感染症"]';
const small = '["synthetic-small","感染症"]';
const data = fixture();
function gas() {
  const e = environment({indexed:true});
  for (const [name, rows] of Object.entries(data.tables)) e.tables[name] = structuredClone(rows);
  e.tables.Settings.find(r=>r[0]==='revision')[1]=data.generation;
  return e;
}
function changes(n=1, version=0, status='want_fulltext') {
  return Array.from({length:n},(_,i)=>({pmid:String(i+1),status:i%2?'reviewed_no_fulltext':status,note:i===0?'🧪'.repeat(1000):`架空メモ${i}`,expected_version:version}));
}
async function setup(t) {
  const e = await runtime();
  t.after(()=>e.mf.dispose());
  await seed(e.mf,data);
  return e;
}
async function request(mf, n=1, key=main) {
  const {value}=await call(mf,'listIssuePapers',{issue_key:key});
  return {operation_id:crypto.randomUUID(),review_operation_id:crypto.randomUUID(),revision:value.revision,
    issue_key:key,expected_version:value.issue.version,content_version:value.issue.content_version,changes:changes(n)};
}
async function counts(db) {
  return db.prepare(`SELECT (SELECT count(*) FROM review_events) papers,
    (SELECT count(*) FROM issue_events) issues,(SELECT count(*) FROM operations) operations,
    (SELECT count(*) FROM operation_ids) ids,(SELECT count(*) FROM review_current) current`).first();
}
function project(items) {return items.map(p=>({pmid:p.pmid,title:p.title,review:Object.fromEntries(
  ['version','status','note','status_updated_at','updated_at'].map(k=>[k,p.review[k]])),score:p.score}));}

test('Python fixture and D1 lists agree with GAS for six deliveries, pagination, scores and literal search',async t=>{
  const {mf}=await setup(t),e=gas();
  const listed=await call(mf,'listIssues');
  assert.deepEqual(listed.value.items,e.plain(e.ctx.listIssues({status:'all'}).items));
  for(const i of listed.value.items){
    for(const query of ['','CLINICAL','%','_',"'quote'",'日本語','🧪','İ','2']){
      const r={issue_key:i.issue_key,query,offset:0};
      const got=await call(mf,'listIssuePapers',r),expected=e.plain(e.ctx.listIssuePapers(r));
      assert.equal(got.status,200);assert.equal(got.value.total,expected.total);
      assert.deepEqual(project(got.value.items),project(expected.items));
      assert.equal(got.value.scores_available,expected.scores_available);
      assert(!JSON.stringify(got.value.items).includes('summary_ja'));
    }
  }
  const second=await call(mf,'listIssuePapers',{issue_key:main,offset:50});
  assert.equal(second.value.items.length,50);assert.equal(second.value.items[0].pmid,'51');
  const detail=await call(mf,'getPaperDetail',{pmid:'1',issue_key:main});
  assert.deepEqual(detail.value.appearances,e.plain(e.ctx.getPaperDetail({pmid:'1',issue_key:main}).appearances));
});

test('100 mixed edits and completion commit once; lost response retries and GAS states agree',async t=>{
  const {mf,db}=await setup(t),r=await request(mf,100),e=gas();
  const lost=await call(mf,'saveAndCompleteIssue',r,{fault:'drop-response'});
  assert.equal(lost.status,503);
  const result=await call(mf,'saveAndCompleteIssue',r);
  assert.equal(result.status,200);assert.equal(result.value.replayed,true);assert.equal(result.value.completed,true);
  assert.deepEqual(await counts(db),{papers:100,issues:1,operations:1,ids:2,current:100});
  const baseline=e.ctx.saveAndCompleteIssue(r);
  assert.equal(baseline.completed,true);
  for(const offset of [0,50]){
    const got=await call(mf,'listIssuePapers',{issue_key:main,offset});
    const expected=e.plain(e.ctx.listIssuePapers({issue_key:main,offset}));
    const strip=p=>({...p,review:{...p.review,status_updated_at:'',updated_at:''}});
    assert.deepEqual(project(got.value.items).map(strip),project(expected.items).map(strip));
  }
  assert.equal((await call(mf,'saveAndCompleteIssue',{...r,changes:changes(100,0,'read')})).status,409);
  assert.equal((await counts(db)).papers,100);
});

test('a conflict in the last of 100 edits, invalid inputs and incomplete completion leave no writes',async t=>{
  const {mf,db}=await setup(t),r=await request(mf,100),empty=await counts(db);
  const bad=structuredClone(r);bad.changes[99].expected_version=1;
  assert.equal((await call(mf,'saveAndCompleteIssue',bad)).status,409);assert.deepEqual(await counts(db),empty);
  for(const mutate of [x=>x.changes.push({...x.changes[0]}),x=>x.changes[99].pmid=x.changes[0].pmid,x=>x.changes[0].note+='x',
    x=>x.changes[0].status='invalid',x=>x.changes[0].pmid='120',x=>x.content_version='wrong',x=>x.expected_version=3]){
    const x=structuredClone(r);mutate(x);assert.notEqual((await call(mf,'saveAndCompleteIssue',x)).status,200);
    assert.deepEqual(await counts(db),empty);
  }
  assert.equal((await call(mf,'saveAndCompleteIssue',await request(mf,1))).status,409);
  assert.deepEqual(await counts(db),empty);
});

test('D1 batch rollback removes trigger writes and operation IDs; same request can recover',async t=>{
  const {mf,db}=await setup(t),r=await request(mf,1,small),empty=await counts(db);
  assert.equal((await call(mf,'saveAndCompleteIssue',r,{fault:'rollback'})).status,409);
  assert.deepEqual(await counts(db),empty);
  assert.equal((await call(mf,'saveAndCompleteIssue',r)).value.completed,true);
  assert.deepEqual(await counts(db),{papers:1,issues:1,operations:1,ids:2,current:1});
});

test('two concurrent clients with the same version produce exactly one winner',async t=>{
  const {mf,db}=await setup(t),r=await request(mf,1,small);
  const other={...r,operation_id:crypto.randomUUID(),review_operation_id:crypto.randomUUID(),changes:changes(1,0,'read')};
  const results=await Promise.all([call(mf,'saveAndCompleteIssue',r),call(mf,'saveAndCompleteIssue',other)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await counts(db)).papers,1);assert.equal((await counts(db)).issues,1);
});

test('old retry cannot overwrite a later note edit or delivery reopen; status time is stable for note-only edits',async t=>{
  const {mf,db}=await setup(t),r=await request(mf,1,small);
  const first=(await call(mf,'saveAndCompleteIssue',r)).value;
  const edit={operation_id:crypto.randomUUID(),revision:r.revision,issue_key:small,
    changes:[{pmid:'1',expected_version:1,status:'want_fulltext',note:'later'}]};
  const saved=(await call(mf,'saveReviews',edit)).value;
  assert.equal(saved.reviews[0].review.status_updated_at,first.reviews[0].review.status_updated_at);
  assert.equal((await call(mf,'saveReviews',edit)).value.replayed,true);
  await call(mf,'saveIssueReview',{operation_id:crypto.randomUUID(),revision:r.revision,issue_key:small,
    changes:[],expected_version:1,content_version:r.content_version,status:'in_progress'});
  const before=await counts(db),retry=(await call(mf,'saveAndCompleteIssue',r)).value;
  assert.equal(retry.completion_recorded,true);assert.equal(retry.completed,false);
  assert.equal(retry.reviews[0].review.note,'later');assert.deepEqual(await counts(db),before);
  assert.equal((await call(mf,'saveReviews',{...edit,operation_id:r.review_operation_id})).status,409);
});

test('metadata staging stays invisible, publication uses CAS, and sync never rewrites review history',async t=>{
  const {mf,db}=await setup(t),r=await request(mf,1,small);
  await call(mf,'saveAndCompleteIssue',r);
  const before=await counts(db),revised=fixture(true);
  assert.equal((await call(mf,'stage',revised,{sync:true})).status,200);
  assert.equal((await call(mf,'listIssues')).value.revision,data.generation);
  const publish={generation:revised.generation,expected_revision:data.generation};
  assert.equal((await call(mf,'publish',publish,{sync:true})).status,200);
  const issue=(await call(mf,'listIssuePapers',{issue_key:small})).value.issue;
  assert.equal(issue.content_changed,true);assert.equal(issue.status,'in_progress');
  assert.equal((await call(mf,'publish',publish,{sync:true})).status,200);
  assert.equal((await call(mf,'publish',{generation:data.generation,expected_revision:null},{sync:true})).status,409);
  assert.equal((await call(mf,'stage',revised,{sync:true})).status,200);
  assert.deepEqual(await counts(db),before);
  assert.equal((await call(mf,'saveReviews',{operation_id:crypto.randomUUID(),revision:data.generation,changes:changes(1,1)})).status,409);
  assert.equal((await call(mf,'saveAndCompleteIssue',r)).value.completed,false);
  const changed=structuredClone(revised);changed.tables.Papers[1][1]='different';
  assert.equal((await call(mf,'stage',changed,{sync:true})).status,409);
  assert.deepEqual(await counts(db),before);
});

test('completion without edits, all five states, 51 edits and duplicate IDs retain expected semantics',async t=>{
  const {mf,db}=await setup(t),r=await request(mf,51);
  const edit={operation_id:crypto.randomUUID(),revision:r.revision,changes:r.changes};
  assert.equal((await call(mf,'saveReviews',edit)).status,200);
  for(const [index,status]of ['unreviewed','reviewed_no_fulltext','want_fulltext','fulltext_obtained','read'].entries()){
    assert.equal((await call(mf,'saveReviews',{operation_id:crypto.randomUUID(),revision:r.revision,
      changes:[{pmid:'120',expected_version:index,status,note:'=literal'}]})).status,200);
  }
  const zero=await request(mf,0,small);
  delete zero.review_operation_id;
  assert.equal((await call(mf,'saveAndCompleteIssue',zero)).value.completed,true);
  assert.equal((await counts(db)).papers,56);
});

test('local-only gate, origin, mock identities and sync ownership reject cross-access',async t=>{
  const {mf,db}=await setup(t),before=await counts(db);
  assert.equal((await call(mf,'listIssues',{}, {token:''})).status,403);
  assert.equal((await call(mf,'listIssues',{}, {token:'Bearer stranger'})).status,403);
  assert.equal((await call(mf,'listIssues',{}, {token:'Bearer local-synthetic-sync'})).status,403);
  assert.equal((await call(mf,'stage',data,{sync:true,token:'Bearer local-synthetic-owner'})).status,403);
  assert.equal((await call(mf,'listIssues',{}, {origin:'https://example.com'})).status,403);
  assert.equal((await mf.dispatchFetch('https://example.com/api/listIssues')).status,403);
  const bad=structuredClone(data);bad.tables.Reviews=[['forbidden']];
  assert.equal((await call(mf,'stage',bad,{sync:true})).status,400);
  assert.deepEqual(await counts(db),before);
  const blocked=await runtime({local:false});t.after(()=>blocked.mf.dispose());
  assert.equal((await call(blocked.mf,'listIssues')).status,403);
});

test('local persistent D1 survives runtime restart with notes, events and replay identity intact',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pmid-d1-restart-'));
  let active;
  try {
    active=await runtime({persist:directory});
    await seed(active.mf,data);
    const r=await request(active.mf,1,small);
    assert.equal((await call(active.mf,'saveAndCompleteIssue',r)).value.completed,true);
    const before=await counts(active.db);
    await active.mf.dispose();active=null;
    active=await runtime({persist:directory});
    const retry=await call(active.mf,'saveAndCompleteIssue',r);
    assert.equal(retry.status,200);assert.equal(retry.value.replayed,true);
    assert.equal(retry.value.reviews[0].review.note,r.changes[0].note);
    assert.deepEqual(await counts(active.db),before);
  } finally {if(active)await active.mf.dispose();await rm(directory,{recursive:true,force:true});}
});
