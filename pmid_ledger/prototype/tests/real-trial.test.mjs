import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {runtime,seed,call} from '../runtime.mjs';
import {manifestFor,validateManifest} from '../chunked.mjs';
import {hash} from '../metadata.mjs';
import {exportBackup,validateBackup} from '../backup-data.mjs';
import {browseWindow} from '../browse.mjs';
import {verifiedArchive,importReviews} from '../trial-maintenance.mjs';
const root=new URL('../../../',import.meta.url);
function trialData(){return JSON.parse(execFileSync('python3',['-c',`import json
from pmid_ledger.core import Dataset,to_tables
from datetime import datetime
from zoneinfo import ZoneInfo
x=Dataset();x.snapshot('10000001','trial','trial-topic','local-test',datetime.now(ZoneInfo('Asia/Tokyo')).date().isoformat(),title='trial paper',summary_ja='trial body')
print(json.dumps(to_tables(x.payload())))`],{cwd:root,encoding:'utf8'}));}
async function action(mf,name,body){return call(mf,name,body,{sync:true});}
test('real copy stays separate, requires current backup cutoff, preserves old state and round-trips both generations',async t=>{
 const rt=await runtime();t.after(()=>rt.mf.dispose());const baseline=await seed(rt.mf);
 const saved=await call(rt.mf,'saveReviews',{operation_id:crypto.randomUUID(),revision:baseline.generation,changes:[{pmid:'1',expected_version:0,status:'want_fulltext',note:'keep original TEST note'}]});assert.equal(saved.status,200);
 const ownerCall=async(name,body)=>{const r=await call(rt.mf,name,body);assert.equal(r.status,200);return r.value;};
 const folder=await fs.mkdtemp('/private/tmp/ledger-trial-');t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const backup=await verifiedArchive(ownerCall,new URL('before.ndjson','file://'+folder+'/'));assert.equal(backup.restore_readback_verified,true);
 const tables=trialData(),p=await manifestFor(tables),generation=await hash(['real-copy',tables]);p.manifest.data_source='real-copy';p.manifest.trial_window=browseWindow();
 assert.throws(()=>validateManifest({...p.manifest,tables:{...p.manifest.tables,Papers:{...p.manifest.tables.Papers,count:51}}}),/small_trial/);
 assert.equal((await action(rt.mf,'begin',{synthetic:true,generation,manifest:p.manifest})).status,400);
 assert.equal((await action(rt.mf,'begin',{real_copy:true,generation,manifest:p.manifest})).status,200);
 for(const c of p.chunks)assert.equal((await action(rt.mf,'chunk',{generation,...c})).status,200);
 assert.equal((await action(rt.mf,'build',{generation,offset:0})).status,200);assert.equal((await action(rt.mf,'finish',{generation})).status,200);
 const publish={generation,expected_revision:baseline.generation};
 assert.equal((await action(rt.mf,'publish',publish)).status,409);
 assert.equal((await action(rt.mf,'publish',{...publish,backup_cutoff:0})).status,409);
 assert.equal((await action(rt.mf,'publish',{...publish,backup_cutoff:backup.snapshot.cutoff})).status,200);
 const issues=await ownerCall('listIssues',{scope:'recent'});assert.equal(issues.total,1);assert.equal(issues.data_source,'real-copy');
 const key=tables.Issues[1][0],plan={tables,generation,review_request:{operation_id:crypto.randomUUID(),revision:generation,changes:[{pmid:'10000001',expected_version:0,status:'want_fulltext',note:'copy only'}]},issue_requests:[{operation_id:crypto.randomUUID(),revision:generation,issue_key:key,expected_version:0,status:'completed',content_version:tables.Issues[1][5]}]};
 assert.equal((await importReviews(ownerCall,plan)).verified,true);assert.equal((await importReviews(ownerCall,plan)).verified,true);
 assert.equal((await action(rt.mf,'publish',{generation:baseline.generation,expected_revision:generation,backup_cutoff:backup.snapshot.cutoff})).status,409);
 const compact=await exportBackup(rt.db);assert.equal(compact.payload.synthetic,false);await validateBackup(compact);
 const latest=await verifiedArchive(ownerCall,new URL('after.ndjson','file://'+folder+'/'));assert.equal(latest.snapshot.synthetic,false);assert.equal(latest.restore_readback_verified,true);
 assert.equal((await action(rt.mf,'publish',{generation:baseline.generation,expected_revision:generation,backup_cutoff:latest.snapshot.cutoff})).status,200);
 const old=await ownerCall('listIssuePapers',{issue_key:'["synthetic-small","感染症"]'});assert.equal(old.items[0].review.note,'keep original TEST note');
 assert.equal((await rt.db.prepare('SELECT count(*) n FROM papers').first()).n,121);
});
