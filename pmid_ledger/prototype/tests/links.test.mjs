import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime,seed,call,fixture} from '../runtime.mjs';
import {hash} from '../metadata.mjs';
import {manifestFor,headers} from '../chunked.mjs';
import {readLink} from '../online-links.mjs';
const key='["synthetic-small","感染症"]';

test('document fragments retain Japanese delivery keys and reject ambiguous or invalid targets',()=>{
  assert.deepEqual(readLink('#issue='+encodeURIComponent(key)+'&pmid=1'),{issue_key:key,pmid:'1'});
  assert.deepEqual(readLink('#pmid=123'),{pmid:'123'});assert.equal(readLink(''),null);
  for(const fragment of ['#pmid=0','#pmid=1&pmid=2','#issue=not-json','#issue=%5B%22x%22%5D','#redirect=https://other.invalid','#pmid=1&token=secret'])assert.throws(()=>readLink(fragment));
});

test('delivery and PMID links resolve exact membership without creating review operations',async t=>{
  const rt=await runtime();t.after(()=>rt.mf.dispose());await seed(rt.mf);
  const direct=await call(rt.mf,'resolveLink',{issue_key:key,pmid:'1'});assert.equal(direct.status,200);assert.equal(direct.value.read_only,false);
  assert.equal(direct.value.issue_key,key);assert.equal((await call(rt.mf,'resolveLink',{pmid:'120'})).status,200);
  assert.equal((await call(rt.mf,'resolveLink',{issue_key:key,pmid:'120'})).status,404);
  for(const body of [{},{pmid:'0'},{issue_key:'[]'},{pmid:1}])assert.equal((await call(rt.mf,'resolveLink',body)).status,400);
  const selected=await call(rt.mf,'listIssuePapers',{issue_key:'["synthetic-main","感染症"]',pmid:'1'});
  assert.equal(selected.value.total,1);assert.deepEqual(selected.value.items.map(p=>p.pmid),['1']);
  assert.equal((await rt.db.prepare('SELECT count(*) n FROM operations').first()).n,0);
});

test('completed links remain read-only after queue sync removes the issue; unpublished uploads stay inaccessible',async t=>{
  const rt=await runtime();t.after(()=>rt.mf.dispose());const initial=await seed(rt.mf);
  const open=(await call(rt.mf,'listIssuePapers',{issue_key:key})).value;
  assert.equal((await call(rt.mf,'saveAndCompleteIssue',{operation_id:crypto.randomUUID(),review_operation_id:crypto.randomUUID(),revision:initial.generation,
    issue_key:key,expected_version:0,content_version:open.issue.content_version,changes:[{pmid:'1',expected_version:0,status:'want_fulltext',note:'preserved note'}]})).status,200);
  assert.equal((await call(rt.mf,'resolveLink',{issue_key:key})).value.read_only,false);
  const tables=Object.fromEntries(Object.entries(headers).map(([n,h])=>[n,[h]]));
  const p=await manifestFor(tables);Object.assign(p.manifest,{data_source:'recent-copy',trial_window:{from:'1900-01-01',through:'2026-11-10'},source_hash:await hash(tables),pending_queue:{policy:'unfinished-v1',deferred_issues:0}});
  const generation=await hash(p.manifest);
  for(const [name,body]of [['begin',{recent_copy:true,generation,manifest:p.manifest}],['finish',{generation}],['publish',{generation,expected_revision:initial.generation,backup_cutoff:1}]])assert.equal((await call(rt.mf,name,body,{sync:true})).status,200,name);
  const target=(await call(rt.mf,'resolveLink',{issue_key:key,pmid:'1'})).value;
  assert.equal(target.read_only,true);assert.equal(target.revision,initial.generation);
  assert.equal((await call(rt.mf,'resolveLink',{pmid:'1'})).value.read_only,true);
  const archive=await call(rt.mf,'listIssuePapers',{issue_key:key,revision:target.revision,pmid:'1'});
  assert.equal(archive.status,200);assert.equal(archive.value.read_only,true);assert.equal(archive.value.issue.status,'completed');
  assert.equal(archive.value.items[0].review.note,'preserved note');
  assert.equal((await call(rt.mf,'getPaperDetail',{issue_key:key,revision:target.revision,pmid:'1'})).status,200);
  assert.equal((await call(rt.mf,'saveReviews',{operation_id:crypto.randomUUID(),revision:target.revision,issue_key:key,changes:[{pmid:'1',expected_version:1,status:'unreviewed',note:'must not save'}]})).status,409);
  const staged=fixture(true).tables,unpublished='f'.repeat(64),hidden='["not-published","感染症"]';
  for(const r of staged.Issues.slice(1))if(r[0]===key){r[0]=hidden;r[1]='not-published';}
  for(const r of staged.Appearances.slice(1))if(r[2]==='synthetic-small')r[2]='not-published';
  for(const r of staged.IssueCandidates.slice(1))if(r[0]===key)r[0]=hidden;
  assert.equal((await call(rt.mf,'stage',{synthetic:true,generation:unpublished,tables:staged},{sync:true})).status,200);
  assert.equal((await call(rt.mf,'resolveLink',{issue_key:hidden})).status,404);
  assert.equal((await call(rt.mf,'listIssuePapers',{issue_key:hidden,revision:unpublished})).status,404);
  assert.equal((await call(rt.mf,'getPaperDetail',{issue_key:hidden,revision:unpublished,pmid:'1'})).status,404);
  assert.equal((await rt.db.prepare('SELECT count(*) n FROM operations').first()).n,1);
});
