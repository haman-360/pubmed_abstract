import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runtime,seed,call,fixture} from '../runtime.mjs';
import {collectWanted,saveWanted} from '../export-wanted.mjs';
import {hash} from '../metadata.mjs';
import {manifestFor} from '../chunked.mjs';
import {downloadBackup,consumeBackup} from '../backup-client.mjs';
import {restoreStream} from '../restore-stream.mjs';

test('Python queue sync fills older unfinished deliveries and preserves completed wishes across repeated sync',async t=>{
  const rt=await runtime();t.after(()=>rt.mf.dispose());await seed(rt.mf);
  const script=`import json,sys
from pmid_ledger.core import Dataset,to_tables,HEADERS
from pmid_ledger.prototype.recent_data import plan_recent
from pmid_ledger.prototype.recent_sync import sync_recent,read_queue_state
from pmid_ledger.prototype.sync_local import LocalTransport
x=Dataset()
for p,i,d in [('10000001','old','2025-01-01'),('10000002','middle','2026-01-01'),('10000003','new','2026-11-01')]:
 x.snapshot(p,i,'topic','test',d,title='test',summary_ja='body '+p)
s=to_tables(x.payload());s.update(Reviews=[HEADERS['Reviews'],['source-op','10000003','1','want_fulltext','','source note','','']],IssueReviews=[HEADERS['IssueReviews']])
r=next(r for r in s['Issues'][1:] if r[1]=='new');s['IssueReviews'].append(['source-done',r[0],'1','completed',r[5],'',''])
t=LocalTransport(sys.argv[1],attempts=1);before=t.post('recentStatus',{});state=read_queue_state(t);state['limit']=1
p=plan_recent(s,queue_state=state)
backup={'verified':True,'restore_readback_verified':True,'snapshot':{'active_revision':before['revision'],'cutoff':before['cutoff']}}
print(json.dumps(sync_recent(p,t,backup)))`;
  // recentStatus deliberately rejects a synthetic baseline, so start from a bounded real-copy fixture.
  const tables=JSON.parse(execFileSync('python3',['-c',`import json
from pmid_ledger.core import Dataset,to_tables
x=Dataset();x.snapshot('10000004','baseline','topic','test','2026-11-01',title='base',summary_ja='base')
print(json.dumps(to_tables(x.payload())))`],{cwd:new URL('../../../',import.meta.url),encoding:'utf8'}));
  const p=await manifestFor(tables);Object.assign(p.manifest,{data_source:'real-copy',trial_window:{from:'2026-11-01',through:'2026-11-06'}});const g=await hash(p.manifest),prior=(await call(rt.mf,'listIssues')).value.revision;
  assert.equal((await call(rt.mf,'begin',{real_copy:true,generation:g,manifest:p.manifest},{sync:true})).status,200);
  for(const chunk of p.chunks)assert.equal((await call(rt.mf,'chunk',{generation:g,...chunk},{sync:true})).status,200);
  for(const [n,b]of [['build',{generation:g,offset:0}],['finish',{generation:g}],['publish',{generation:g,expected_revision:prior,backup_cutoff:0}]])assert.equal((await call(rt.mf,n,b,{sync:true})).status,200);
  const run=async()=>JSON.parse((await promisify(execFile)('python3',['-c',script,String(await rt.mf.ready)],{cwd:new URL('../../../',import.meta.url),timeout:30000})).stdout);
  assert.equal((await run()).deferred_issues,1);
  assert.equal((await call(rt.mf,'listIssues')).value.items[0].issue_id,'middle');
  assert.equal((await rt.db.prepare("SELECT note FROM review_current WHERE pmid='10000003'").first()).note,'source note');
  const item=(await call(rt.mf,'listIssues')).value.items[0],open=(await call(rt.mf,'listIssuePapers',{issue_key:item.issue_key})).value;
  assert.equal((await call(rt.mf,'saveAndCompleteIssue',{operation_id:crypto.randomUUID(),review_operation_id:crypto.randomUUID(),revision:open.revision,issue_key:item.issue_key,expected_version:item.version,content_version:item.content_version,
    changes:[{pmid:'10000002',expected_version:0,status:'want_fulltext',note:'completed local note'}]})).status,200);
  assert.equal((await call(rt.mf,'listIssues')).value.total,0);
  assert.equal((await run()).deferred_issues,0);
  assert.equal((await call(rt.mf,'listIssues')).value.items[0].issue_id,'old');
  const before=(await rt.db.prepare('SELECT count(*) n FROM operations').first()).n;
  assert.equal((await run()).metadata_changed,false);assert.equal((await rt.db.prepare('SELECT count(*) n FROM operations').first()).n,before);
  assert.deepEqual((await call(rt.mf,'wantedPmids')).value.pmids,['10000002','10000003']);
  assert.equal((await rt.db.prepare("SELECT note FROM review_current WHERE pmid='10000002'").first()).note,'completed local note');
});

test('completed issues are excluded before paging; old dates remain, wishes survive and changed content returns',async t=>{
  const rt=await runtime();t.after(()=>rt.mf.dispose());const data=await seed(rt.mf),key='["synthetic-small","感染症"]';
  const open=(await call(rt.mf,'listIssuePapers',{issue_key:key})).value;
  const complete=await call(rt.mf,'saveAndCompleteIssue',{operation_id:crypto.randomUUID(),review_operation_id:crypto.randomUUID(),revision:data.generation,
    issue_key:key,expected_version:0,content_version:open.issue.content_version,changes:[{pmid:'1',expected_version:0,status:'want_fulltext',note:'keep after completion'}]});
  assert.equal(complete.status,200);assert.equal(complete.value.completed,true);
  const pending=await call(rt.mf,'listIssues');assert.equal(pending.value.total,5);assert(!pending.value.items.some(i=>i.issue_key===key));
  assert(pending.value.items.some(i=>i.delivered_date==='2026-01-10'));
  assert.equal((await call(rt.mf,'wantedPmids')).value.pmids[0],'1');
  const readOnly=await call(rt.mf,'wantedPmids');assert.equal(readOnly.value.cutoff,1);
  await seed(rt.mf,fixture(true),data.generation);
  assert((await call(rt.mf,'listIssues')).value.items.some(i=>i.issue_key===key&&i.status==='in_progress'));
  assert.equal((await rt.db.prepare("SELECT note FROM review_current WHERE pmid='1'").first()).note,'keep after completion');
  assert.equal((await call(rt.mf,'wantedPmids',{}, {sync:true})).status,404);
  assert.equal((await call(rt.mf,'queueState',{kind:'issues'})).status,404);
});

test('an empty pending generation retains period-independent wishes, notes and a restorable backup',async t=>{
  const rt=await runtime();t.after(()=>rt.mf.dispose());const initial=await seed(rt.mf);
  assert.equal((await call(rt.mf,'saveReviews',{operation_id:crypto.randomUUID(),revision:initial.generation,
    changes:[{pmid:'1',expected_version:0,status:'want_fulltext',note:'archived note'}]})).status,200);
  const {headers}=await import('../chunked.mjs');const tables=Object.fromEntries(Object.entries(headers).map(([n,h])=>[n,[h]]));
  const p=await manifestFor(tables);Object.assign(p.manifest,{data_source:'recent-copy',trial_window:{from:'1900-01-01',through:'2026-11-06'},source_hash:await hash(tables),pending_queue:{policy:'unfinished-v1',deferred_issues:0}});
  const generation=await hash(p.manifest);
  for(const [n,b]of [['begin',{recent_copy:true,generation,manifest:p.manifest}],['finish',{generation}],['publish',{generation,expected_revision:initial.generation,backup_cutoff:1}]])assert.equal((await call(rt.mf,n,b,{sync:true})).status,200,n);
  assert.equal((await call(rt.mf,'listIssues')).value.total,0);
  assert.equal((await rt.db.prepare('SELECT count(*) n FROM papers WHERE generation=?').bind(generation).first()).n,0);
  const output=await collectWanted(async body=>{const r=await call(rt.mf,'wantedPmids',body);assert.equal(r.status,200);return r.value;});assert.equal(output.text,'1\n');
  const lines=[];for await(const line of downloadBackup(async(n,b)=>(await call(rt.mf,n,b)).value))lines.push(line);
  const empty=await runtime();t.after(()=>empty.mf.dispose());
  const triggers=(await fs.readFile(new URL('../schema.sql',import.meta.url),'utf8')).split('\n-- statement\n').filter(s=>s.trim().startsWith('CREATE TRIGGER'));
  await restoreStream(empty.db,lines,triggers);assert.equal((await consumeBackup(lines)).snapshot.active_revision,generation);
  assert.equal((await call(empty.mf,'wantedPmids')).value.pmids[0],'1');
  assert.equal((await empty.db.prepare("SELECT note FROM review_current WHERE pmid='1'").first()).note,'archived note');
});

test('wanted export pages use a fixed operation boundary; output is numeric, BOM-free, private and never overwrites',async t=>{
  const rt=await runtime();t.after(()=>rt.mf.dispose());const initial=await seed(rt.mf);
  await call(rt.mf,'saveReviews',{operation_id:crypto.randomUUID(),revision:initial.generation,changes:['100','2','10'].map(pmid=>({pmid,expected_version:0,status:'want_fulltext',note:'saved note'}))});
  const first=(await call(rt.mf,'wantedPmids')).value;
  await call(rt.mf,'saveReviews',{operation_id:crypto.randomUUID(),revision:initial.generation,changes:[{pmid:'2',expected_version:1,status:'reviewed_no_fulltext',note:'saved note'}]});
  assert.equal((await call(rt.mf,'wantedPmids',{after:first.after,cutoff:first.cutoff})).status,409);
  assert.equal((await call(rt.mf,'wantedPmids',{after:'2'})).status,400);
  let calls=0;const all=await collectWanted(async r=>{calls++;return r.after===''?{pmids:['10','100'],after:'100',cutoff:7,done:false}:{pmids:['2'],after:'2',cutoff:7,done:true};});
  assert.equal(calls,2);assert.equal(all.text,'2\n10\n100\n');
  const directory=await fs.mkdtemp(os.tmpdir()+'/pmid-export-');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const folder=pathToFileURL(directory+'/'),one=await saveWanted(all,folder),two=await saveWanted({count:0,text:''},folder);
  assert.notEqual(one,two);assert.equal((await fs.stat(one)).mode&0o777,0o600);assert.equal(await fs.readFile(one,'utf8'),all.text);
  assert.equal((await fs.readFile(two)).length,0);
  for(const result of [{pmids:['1','1'],after:'1',cutoff:1,done:true},{pmids:['not-a-pmid'],after:'not-a-pmid',cutoff:1,done:true},{pmids:[],after:'',cutoff:1,done:false}])await assert.rejects(()=>collectWanted(async()=>result));
});

test('5000-paper pending browse aggregates progress only for its 20 returned issues',async t=>{
  const data=JSON.parse(execFileSync('python3',['-m','pmid_ledger.prototype.fixture','--scale','--browse'],{cwd:new URL('../../../',import.meta.url),encoding:'utf8',maxBuffer:30000000}));
  const rt=await runtime();t.after(()=>rt.mf.dispose());await seed(rt.mf,data);
  // Populate fixed synthetic state for a read-cost comparison, without generating 9000 unrelated save operations.
  await rt.db.prepare(`INSERT INTO issue_current SELECT issue_key,1,'completed',content_version,'' FROM issues WHERE generation=? AND issue_key NOT LIKE '%-000%'`).bind(data.generation).run();
  const result=await call(rt.mf,'listIssues',{}, {profile:true});assert.equal(result.status,200);assert.equal(result.value.total,1);assert.equal(result.value.items.length,1);
  assert(result.profile.rows_read<5000,`${result.profile.rows_read} pending reads`);
  assert(!JSON.stringify(result.value).includes('架空の本文'));
  console.log(JSON.stringify({scope:'pending-5000-papers-199-completed',rows_read:result.profile.rows_read,database_calls:result.profile.database_calls,returned_issues:result.value.items.length}));
  await rt.db.prepare(`INSERT INTO review_current SELECT pmid,1,'want_fulltext','private fixture note','',''
    FROM papers WHERE generation=? ORDER BY pmid LIMIT 501`).bind(data.generation).run();
  const first=(await call(rt.mf,'wantedPmids')).value;assert.equal(first.pmids.length,500);assert.equal(first.done,false);
  const last=(await call(rt.mf,'wantedPmids',{after:first.after,cutoff:first.cutoff})).value;assert.equal(last.pmids.length,1);assert.equal(last.done,true);
  const output=await collectWanted(async b=>(await call(rt.mf,'wantedPmids',b)).value);assert.equal(output.count,501);
  const compact=(await call(rt.mf,'queueState',{kind:'reviews'},{sync:true})).value;assert.equal(compact.items.length,500);assert.equal(compact.done,false);
  assert(!JSON.stringify(compact).includes('private fixture note'));
});
