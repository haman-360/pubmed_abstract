// Loopback HTTP and disposable local D1 only; no existing data, auth or paid services.
import {runtime,call} from './runtime.mjs';
import {backupColumns} from './backup-data.mjs';
import {downloadBackup,consumeBackup} from './backup-client.mjs';
import {restoreStream} from './restore-stream.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import {readBackupLines} from './backup-file.mjs';
import assert from 'node:assert/strict';
const exec=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url));
const quick=process.argv.includes('--quick'),samples=quick?5:30,historyTarget=quick?1000:50000;
async function python(args){const {stdout}=await exec('python3',['-m','pmid_ledger.prototype.sync_local',...args],{cwd:root,timeout:30000});return JSON.parse(stdout);}
async function syncAll(args){
  const runs=[];
  for(let i=0;i<10;i++){
    const result=await python(args);runs.push(result);
    if(!result.paused)return {...result,requests:runs.reduce((n,r)=>n+r.requests,0),local_runs:runs};
  }
  throw new Error('Local write-budget rehearsal did not finish');
}
const round=n=>Math.round(n*1000)/1000;
function summary(rows){
  const values=rows.map(r=>r.elapsed_ms).sort((a,b)=>a-b),p=n=>values[Math.ceil(n*values.length)-1];
  return {samples:rows.length,failures:0,first_ms:round(rows[0].elapsed_ms),median_ms:round((values[Math.floor((values.length-1)/2)]+values[Math.ceil((values.length-1)/2)])/2),
    p95_ms:round(p(.95)),max_ms:round(values.at(-1)),response_bytes_max:Math.max(...rows.map(r=>r.bytes)),
    sql_statements_max:Math.max(...rows.map(r=>r.profile.statements)),
    local_rows_read_min:Math.min(...rows.map(r=>r.profile.rows_read)),local_rows_read_max:Math.max(...rows.map(r=>r.profile.rows_read)),
    local_rows_written_max:Math.max(...rows.map(r=>r.profile.rows_written)),local_sql_ms_max:Math.max(...rows.map(r=>r.profile.database_ms)),
    worker_wall_ms_max:round(Math.max(...rows.map(r=>r.profile.worker_wall_ms)))};
}
async function measure(operation){const rows=[];for(let i=0;i<samples;i++)rows.push(await operation(i));return summary(rows);}
const report={schema:'LOCAL_D1_LOAD_V2',measured_at:new Date().toISOString(),mode:quick?'quick':'full',samples,
  scope:'localhost HTTP + local workerd/D1; diagnostic overhead included; not cloud CPU, billing, iPad, or production GAS speed',
  method:'sequential first and repeated requests; no forced cache clearing or randomized A/B',cases:[]};

for(const config of [{label:'small-120',args:[]},{label:'scale-500',args:['--scale','--papers','500','--issues','20']},
  {label:'scale-1000',args:['--scale','--papers','1000','--issues','40']},{label:'scale-5000',args:['--scale']}]){
  const stats=await python([...config.args,'--inspect']);
  const entry={label:config.label,...stats};report.cases.push(entry);
  if(!stats.fits_current_sync){entry.result='rejected_before_http';entry.reason='current single-row metadata storage exceeds safe size; chunked storage required';console.log(`${config.label}: preflight rejected (${stats.wire_bytes} bytes), no DB writes`);continue;}
  const {mf,db}=await runtime();
  try{
    const base=String(await mf.ready),version=new Map();let lastOperation;
    const syncStart=performance.now();entry.sync=await syncAll(['--base-url',base,...config.args]);entry.sync.elapsed_ms=round(performance.now()-syncStart);
    entry.unchanged_sync=await python(['--base-url',base,...config.args]);assert.equal(entry.unchanged_sync.changed,false);
    async function request(name,body={},profile=true){
      const start=performance.now();const response=await fetch(new URL('/api/'+name,base),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer local-synthetic-owner',...(profile?{'X-Local-Profile':'1'}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
      const text=await response.text(),data=JSON.parse(text),elapsed_ms=performance.now()-start;
      assert.equal(response.status,200,`${name}: HTTP ${response.status}`);
      if(profile)assert.equal(data.profile.missing_rows_metadata,0);
      return {elapsed_ms,bytes:Buffer.byteLength(text),profile:data.profile,value:data.value};
    }
    const listed=(await request('listIssues',{scope:'all'})).value;
    const selected=[...listed.items].sort((a,b)=>b.total-a.total)[0];
    const issueKey=selected.issue_key;
    const first=(await request('listIssuePapers',{issue_key:issueKey})).value;
    const members=[...first.items];
    for(let offset=50;offset<first.total;offset+=50)members.push(...(await request('listIssuePapers',{issue_key:issueKey,offset})).value.items);
    const revision=first.revision;
    const readCases=async()=>({
      issues:await measure(()=>request('listIssues',{scope:'all'})),
      papers:await measure(()=>request('listIssuePapers',{issue_key:issueKey})),
      search:await measure(()=>request('listIssuePapers',{issue_key:issueKey,query:'日本語'})),
      detail:await measure(()=>request('getPaperDetail',{issue_key:issueKey,pmid:members[0].pmid}))
    });
    entry.reads_before_history=await readCases();
    async function save(ids,complete=false){
      const changes=ids.map(pmid=>({pmid,expected_version:version.get(pmid)??0,status:'want_fulltext',note:'架空の負荷試験メモ'}));
      const operation={operation_id:crypto.randomUUID(),revision,changes,
        ...(complete?{issue_key:issueKey,expected_version:entry.issue_version??0,content_version:selected.content_version,review_operation_id:crypto.randomUUID()}:{})};
      const result=await request(complete?'saveAndCompleteIssue':'saveReviews',operation);if(complete)lastOperation=operation;
      for(const c of changes)version.set(c.pmid,c.expected_version+1);
      if(complete){assert.equal(result.value.completed,true);entry.issue_version=result.value.issue.version;}
      return result;
    }
    entry.saves={};
    for(const count of [1,51,100])entry.saves['papers_'+count]=await measure(()=>save(Array.from({length:count},(_,i)=>String(i+1))));
    entry.saves['complete_'+members.length]=await measure(()=>save(members.map(p=>p.pmid),true));
    if(config.label==='scale-5000'){
      let total=(await db.prepare('SELECT count(*) n FROM review_events').first()).n,step=0;
      while(total<historyTarget){const count=Math.min(100,historyTarget-total),ids=Array.from({length:count},(_,i)=>String((step*100+i)%stats.papers+1));await save(ids);total+=count;step++;if(step%100===0)console.log(`scale-5000: ${total} synthetic history rows`);}
      entry.history_rows_before_second_reads=total;entry.reads_after_history=await readCases();
      entry.saves_after_history={};
      for(const count of [1,51,100])entry.saves_after_history['papers_'+count]=await measure(()=>save(Array.from({length:count},(_,i)=>String(i+1))));
      entry.saves_after_history['complete_'+members.length]=await measure(()=>save(members.map(p=>p.pmid),true));
      const currents=(await db.prepare('SELECT pmid,version FROM review_current').all()).results;
      for(const r of currents)assert.equal(r.version,version.get(r.pmid));
    }
    entry.history_rows_final=(await db.prepare('SELECT count(*) n FROM review_events').first()).n;
    const counts=await db.prepare(`SELECT (SELECT count(*) FROM papers) papers,(SELECT count(*) FROM members) appearances,
      (SELECT count(*) FROM issues) issues,(SELECT count(*) FROM generations) generations`).first();
    assert.equal(counts.papers,stats.papers);assert.equal(counts.appearances,stats.appearances);assert.equal(counts.issues,stats.issues);assert.equal(counts.generations,1);
    entry.integrity_verified=true;entry.result='local_pass';console.log(`${config.label}: local pass; ${entry.history_rows_final} history rows`);
    let maxRow=0,maxValue=0,logicalBytes=0;
    for(const [name,cols]of Object.entries(backupColumns)){
      const lengths=cols.map(c=>`COALESCE(length(CAST(${c} AS BLOB)),0)`);
      const row=await db.prepare(`SELECT COALESCE(max(${lengths.join('+')}),0) row_bytes,COALESCE(max(max(${lengths.join(',')})),0) value_bytes,COALESCE(sum(${lengths.join('+')}),0) logical_bytes FROM ${name}`).first();
      maxRow=Math.max(maxRow,row.row_bytes);maxValue=Math.max(maxValue,row.value_bytes);logicalBytes+=row.logical_bytes;
    }
    assert(maxRow<1900000&&maxValue<1900000);entry.max_logical_row_utf8_bytes=maxRow;entry.max_value_utf8_bytes=maxValue;
    entry.logical_data_utf8_bytes=logicalBytes; // Excludes indexes and SQLite overhead; not billable storage.
    if(config.label==='scale-5000'){
      const folder=new URL('./.benchmarks/',import.meta.url);await fs.mkdir(folder,{recursive:true});const file=new URL('scale-5000.ndjson',folder);
      const handle=await fs.open(file,'w',0o600);let backupRequests=0,maxLine=0;const start=performance.now();
      try{for await(const line of downloadBackup(async(name,body)=>{backupRequests++;return (await request(name,body,false)).value;})){maxLine=Math.max(maxLine,Buffer.byteLength(line));await handle.writeFile(line+'\n');}}finally{await handle.close();}
      entry.backup={elapsed_ms:round(performance.now()-start),requests:backupRequests,bytes:(await fs.stat(file)).size,max_line_bytes:maxLine};
      const target=await runtime();const restoredAt=performance.now();
      try{
        const schema=await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'),triggers=schema.split('\n-- statement\n').filter(s=>s.trim().startsWith('CREATE TRIGGER'));
        const receipt=await restoreStream(target.db,readBackupLines(file),triggers);
        entry.restore={elapsed_ms:round(performance.now()-restoredAt)};
        const checked=await consumeBackup(downloadBackup(async(name,body)=>{const r=await call(target.mf,name,body);assert.equal(r.status,200);return r.value;}));
        assert.equal(checked.chain,receipt.archive_hash);entry.restore.archive_hash_match=true;
        const before=(await target.db.prepare('SELECT count(*) n FROM review_events').first()).n;
        const replay=await call(target.mf,'saveAndCompleteIssue',lastOperation);assert.equal(replay.status,200);assert.equal(replay.value.replayed,true);assert.equal(replay.value.completed,true);
        assert.equal((await target.db.prepare('SELECT count(*) n FROM review_events').first()).n,before);entry.restore.retry_did_not_duplicate=true;
        assert.deepEqual((await call(target.mf,'getPaperDetail',{issue_key:issueKey,pmid:members[0].pmid})).value,(await request('getPaperDetail',{issue_key:issueKey,pmid:members[0].pmid},false)).value);
        entry.restore.detail_match=true;console.log('scale-5000: paged backup, fresh-DB restore, archive readback and replay passed');
      }finally{await target.mf.dispose();}
    }
  }finally{await mf.dispose();}
}
const folder=new URL('./.benchmarks/',import.meta.url);await fs.mkdir(folder,{recursive:true});
const output=new URL(quick?'quick.json':'latest.json',folder);await fs.writeFile(output,JSON.stringify(report,null,2),{mode:0o600});
console.log(fileURLToPath(output));
