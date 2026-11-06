import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {runtime,fixture,seed,call} from '../runtime.mjs';
import {manifestFor} from '../chunked.mjs';
import {hash} from '../metadata.mjs';
import {browseWindow} from '../browse.mjs';
import {downloadBackup,consumeBackup} from '../backup-client.mjs';
import {restoreStream} from '../restore-stream.mjs';
const root=new URL('../../../',import.meta.url);
function data(extra=false){return JSON.parse(execFileSync('python3',['-c',`import json
from pmid_ledger.core import Dataset,to_tables
from datetime import datetime
from zoneinfo import ZoneInfo
x=Dataset();today=datetime.now(ZoneInfo('Asia/Tokyo')).date().isoformat()
x.snapshot('10000001','real-trial','topic','test',today,title='test paper',summary_ja='test text')
if ${extra?'True':'False'}: x.snapshot('10000002','new-delivery','topic','test',today,title='new paper',summary_ja='new text')
print(json.dumps(to_tables(x.payload())))`],{cwd:root,encoding:'utf8'}));}
const sync=(mf,n,b={})=>call(mf,n,b,{sync:true});
async function stage(mf,tables,mode){const p=await manifestFor(tables);p.manifest.data_source=mode;p.manifest.trial_window=browseWindow();if(mode==='recent-copy')p.manifest.source_hash=await hash(tables);p.generation=await hash(p.manifest);
 assert.equal((await sync(mf,'begin',{[mode==='recent-copy'?'recent_copy':'real_copy']:true,generation:p.generation,manifest:p.manifest})).status,200);
 for(const c of p.chunks)assert.equal((await sync(mf,'chunk',{generation:p.generation,...c})).status,200);
 for(let offset=0;offset<p.manifest.tables.Issues.count;offset+=5)assert.equal((await sync(mf,'build',{generation:p.generation,offset})).status,200);
 assert.equal((await sync(mf,'finish',{generation:p.generation})).status,200);return p;}
test('rolling sync preserves TEST edits, seeds only missing states, and archives overlapping old trial generations',async t=>{
 const rt=await runtime();t.after(()=>rt.mf.dispose());const fake=await seed(rt.mf),old=await stage(rt.mf,data(),'real-copy');
 assert.equal((await sync(rt.mf,'publish',{generation:old.generation,expected_revision:fake.generation,backup_cutoff:0})).status,200);
 const request={operation_id:crypto.randomUUID(),revision:old.generation,changes:[{pmid:'10000001',expected_version:0,status:'want_fulltext',note:'keep TEST memo'}]};assert.equal((await call(rt.mf,'saveReviews',request)).status,200);
 const current=await sync(rt.mf,'recentStatus'),p=await stage(rt.mf,data(true),'recent-copy');
 assert.equal((await sync(rt.mf,'publish',{generation:p.generation,expected_revision:old.generation})).status,409);
 assert.equal((await sync(rt.mf,'publish',{generation:p.generation,expected_revision:old.generation,backup_cutoff:current.value.cutoff})).status,200);
 const seeds={revision:p.generation,items:[{pmid:'10000001',status:'read',note:'source must not overwrite'},{pmid:'10000002',status:'reviewed_no_fulltext',note:'initial source memo'}]};
 assert.equal((await sync(rt.mf,'seedReviews',seeds)).status,200);assert.equal((await sync(rt.mf,'seedReviews',seeds)).status,200);
 let rows=(await rt.db.prepare('SELECT pmid,version,status,note FROM review_current ORDER BY pmid').all()).results;
 assert.deepEqual(rows,[{pmid:'10000001',version:1,status:'want_fulltext',note:'keep TEST memo'},{pmid:'10000002',version:1,status:'reviewed_no_fulltext',note:'initial source memo'}]);
 assert.equal((await call(rt.mf,'seedReviews',seeds)).status,404); // Owner surface cannot impersonate the sync role.
 const changed=data(true);changed.Papers[1][1]='updated metadata';const next=await stage(rt.mf,changed,'recent-copy');
 assert.equal((await call(rt.mf,'saveReviews',{operation_id:crypto.randomUUID(),revision:p.generation,changes:[{pmid:'10000001',expected_version:1,status:'want_fulltext',note:'concurrent TEST memo'}]})).status,200);
 assert.equal((await sync(rt.mf,'publish',{generation:next.generation,expected_revision:p.generation})).status,200);
 assert.equal((await sync(rt.mf,'seedReviews',{revision:next.generation,items:seeds.items})).status,200);
 assert.equal((await rt.db.prepare("SELECT note FROM review_current WHERE pmid='10000001'").first()).note,'concurrent TEST memo');
 const lines=[];for await(const l of downloadBackup(async(n,b)=>{const r=await call(rt.mf,n,b);assert.equal(r.status,200);return r.value;}))lines.push(l);
 const empty=await runtime();t.after(()=>empty.mf.dispose());const triggers=fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8').split('\n-- statement\n').filter(s=>s.trim().startsWith('CREATE TRIGGER'));
 assert.equal((await restoreStream(empty.db,lines,triggers)).restored,true);assert.equal((await consumeBackup(lines)).snapshot.synthetic,false);
 assert.equal((await empty.db.prepare("SELECT note FROM review_current WHERE pmid='10000001'").first()).note,'concurrent TEST memo');
});
