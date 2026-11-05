// Synthetic loopback only. Never contacts Cloudflare or the user's running DB.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {runtime,call} from './runtime.mjs';
import {downloadBackup,consumeBackup} from './backup-client.mjs';
const exec=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url));
const rt=await runtime();let window={};
function record(name,p){
  assert.equal(p.missing_rows_metadata,0);
  const s=window[name]??={requests:0,rows_read:0,rows_written:0,database_calls_max:0,database_bytes_max:0};
  s.requests++;s.rows_read+=p.rows_read;s.rows_written+=p.rows_written;
  s.database_calls_max=Math.max(s.database_calls_max,p.database_calls);s.database_bytes_max=Math.max(s.database_bytes_max,p.database_bytes_max);
}
function total(routes){return Object.values(routes).reduce((s,r)=>({requests:s.requests+r.requests,rows_read:s.rows_read+r.rows_read,rows_written:s.rows_written+r.rows_written,
  database_calls_max:Math.max(s.database_calls_max,r.database_calls_max),database_bytes_max:Math.max(s.database_bytes_max,r.database_bytes_max)}),{requests:0,rows_read:0,rows_written:0,database_calls_max:0,database_bytes_max:0});}
const server=http.createServer(async(req,res)=>{
  try{const buffers=[];for await(const b of req)buffers.push(b);
    const r=await rt.mf.dispatchFetch('http://127.0.0.1'+req.url,{method:req.method,headers:{...req.headers,'X-Local-Profile':'1'},body:Buffer.concat(buffers)});
    const raw=await r.text(),data=JSON.parse(raw);assert.equal(r.status,200,raw);record(req.url,data.profile);
    res.writeHead(r.status,{'Content-Type':'application/json'});res.end(raw);
  }catch{res.writeHead(500);res.end('{"error":"local_measurement_failed"}');}
});
const report={schema:'LOCAL_D1_FREE_REHEARSAL_V1',measured_at:new Date().toISOString(),
  scope:'Local metadata only. Consecutive simulated windows, not real UTC days. Excludes auth, other account usage, setup and cloud CPU.',
  limits:{read_rows_per_day:5000000,write_rows_per_day:100000,worker_requests_per_day:100000,db_bytes:500000000,d1_calls_per_request:50},sync_windows:[]};
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  async function sync(){const r=await exec('python3',['-m','pmid_ledger.prototype.sync_local','--base-url',url,'--scale'],{cwd:root,timeout:120000});return JSON.parse(r.stdout);}
  let completed=false;
  for(let i=0;i<10;i++){
    window={};const result=await sync(),sum=total(window);
    assert(sum.rows_written<=80000);assert(sum.rows_read<=4000000);assert(sum.database_calls_max<=50);
    if(result.paused){assert.equal((await rt.db.prepare('SELECT generation FROM settings').first()).generation,null);assert(sum.rows_written<=result.estimated_writes);}
    report.sync_windows.push({result,totals:sum,routes:window});console.log(`window ${i+1}: ${sum.rows_read} reads, ${sum.rows_written} writes, ${result.paused?'unpublished':'published'}`);
    if(!result.paused){assert.equal(result.changed,true);completed=true;break;}
  }
  assert(completed);window={};const unchanged=await sync();assert.equal(unchanged.requests,1);report.unchanged={result:unchanged,...total(window)};
  async function api(name,body={}){const r=await call(rt.mf,name,body,{profile:true});assert.equal(r.status,200);record(name,r.profile);return r.value;}
  window={};const list=await api('listIssues',{scope:'all'}),issue=list.items[0];
  const papers=await api('listIssuePapers',{issue_key:issue.issue_key});
  await api('listIssuePapers',{issue_key:issue.issue_key,query:'日本語'});
  await api('getPaperDetail',{issue_key:issue.issue_key,pmid:papers.items[0].pmid});
  await api('saveReviews',{operation_id:crypto.randomUUID(),revision:list.revision,changes:[{pmid:papers.items[0].pmid,expected_version:0,status:'want_fulltext',note:'synthetic preflight'}]});
  report.session={description:'list, papers, search, detail, one save (5 API requests; no browser auto-refresh)',totals:total(window),routes:window};
  report.use_days=[0,1,4].map(sessions=>({sessions,api_requests:5*sessions,rows_read:report.session.totals.rows_read*sessions,rows_written:report.session.totals.rows_written*sessions}));
  window={};await consumeBackup(downloadBackup(api));report.backup={...total(window),routes:window};
  assert(report.backup.rows_read<=4000000);assert.equal(report.backup.rows_written,0);assert(report.backup.database_calls_max<=50);
  report.database_bytes_local=(await rt.db.prepare('SELECT 1').all()).meta.size_after;
  const folder=new URL('./.benchmarks/',import.meta.url);await fs.mkdir(folder,{recursive:true});await fs.writeFile(new URL('free-plan.json',folder),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({unchanged:report.unchanged,session:report.session.totals,use_days:report.use_days,backup:total(window),database_bytes_local:report.database_bytes_local},null,2));
}finally{await new Promise(r=>{server.close(r);server.closeAllConnections();});await rt.mf.dispose();}
