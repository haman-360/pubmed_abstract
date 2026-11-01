/** Local VM/fixture timings only: no GAS network latency or iPad performance claims. */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { environment } from "./environment.mjs";
const baseline = process.argv[2] || "0b679df";
const oldSource = execFileSync("git", ["show", baseline + ":pmid_ledger/gas/Code.gs"], {encoding:"utf8"});
const newSource = fs.readFileSync(new URL("../gas/Code.gs", import.meta.url), "utf8");
const issueKey = '["issue1","感染症"]';
function fixture(source, candidates) {
  const cache = new Map(), reads = [];
  const e = environment({source,indexed:true,candidates,cache,onRead:(name,tables,range)=>reads.push({name,...range})});
  for (let n=0;n<5000;n++) {
    const id=String(1000+n), paper=[...e.tables.Papers[1]], appearance=[...e.tables.Appearances[1]];
    paper[0]=id; appearance[0]="benchmark-"+id;appearance[1]=id;
    appearance[2]=n<14?"issue1":"other-"+Math.floor(n/50);
    e.tables.Papers.push(paper);e.tables.Appearances.push(appearance);
  }
  e.reindex();
  const list=()=>candidates?e.ctx.listIssuePapers({issue_key:issueKey}):e.ctx.listPapers({issue_key:issueKey,tab:"all"});
  return {...e,cache,reads,list};
}
function measure(source, candidates) {
  const results={};
  for (const operation of ["cold_list","warm_list","save","save_and_complete"]) {
    const times=[],calls=[],ranges=[],rows=[];
    for (let n=0;n<5;n++) {
      const e=fixture(source,candidates);
      let page=e.list();
      if (operation==="cold_list")e.cache.clear();
      e.reads.length=0;
      let rpc=0;
      const started=performance.now();
      if (operation.endsWith("list")) {page=e.list();rpc++;}
      else {
        const changes=page.items.map(p=>({pmid:p.pmid,status:"reviewed_no_fulltext",note:"",expected_version:0}));
        const saved=e.ctx.saveReviews({changes,operation_id:"benchmark-save-"+n, ...(candidates?{issue_key:issueKey}:{})});rpc++;
        if (!candidates){page=e.list();rpc++;}
        if (operation==="save_and_complete") {
          const issue=candidates?saved.issue:page.issue;
          e.ctx.saveIssueReview({issue_key:issueKey,status:"completed",operation_id:"benchmark-complete-"+n,expected_version:issue.version,content_version:issue.content_version});rpc++;
          if (!candidates){e.list();rpc++;}
        }
      }
      times.push(performance.now()-started); calls.push(rpc);ranges.push(e.reads.length);rows.push(e.reads.reduce((n,r)=>n+r.count,0));
    }
    times.sort((a,b)=>a-b);
    results[operation]={median_ms:+times[2].toFixed(2),max_ms:+times[4].toFixed(2),rpc:calls[0],read_ranges:ranges[0],read_rows:rows[0]};
  }
  return results;
}
console.log(JSON.stringify({kind:"local VM only; synthetic 5002 papers / target 15; 5 samples",baseline,before:measure(oldSource,false),after:measure(newSource,true)},null,2));
