import test from 'node:test';
import assert from 'node:assert/strict';
import {environment} from './environment.mjs';
const key='["issue1","感染症"]';
function setup(opts={}){
  const e=environment({indexed:true,candidates:true,cache:new Map(),...opts});
  const issue=e.ctx.listIssuePapers({issue_key:key}).issue;
  const request={issue_key:key,operation_id:'combined-complete-0001',review_operation_id:'combined-papers-0001',
    expected_version:issue.version,content_version:issue.content_version,
    changes:[{pmid:'1',status:'want_fulltext',note:'keep',expected_version:0}]};
  return {...e,request};
}

test('combined saves share one lock/context and replay returns current state without new events',()=>{
  const reads=[],e=setup({onRead:(name,t,r)=>reads.push({name,...r})});
  const original=e.ctx.SpreadsheetApp.openById;let opens=0,locks=0;
  e.ctx.SpreadsheetApp.openById=id=>{opens++;return original(id);};
  const lock=e.ctx.LockService.getScriptLock;e.ctx.LockService.getScriptLock=()=>{locks++;return lock();};
  reads.length=0;
  const result=e.ctx.saveAndCompleteIssue(e.request);
  assert.equal(result.saved,true);assert.equal(result.completed,true);assert.equal(result.completion_recorded,true);
  assert.equal(opens,1);assert.equal(locks,1);assert.equal(reads.length,8);
  assert.equal(e.tables.Reviews.length,2);assert.equal(e.tables.IssueReviews.length,2);
  const before=e.writes();
  const replay=e.ctx.saveAndCompleteIssue(e.request);
  assert.equal(replay.replayed,true);assert.equal(replay.completed,true);assert.equal(e.writes(),before);
  e.ctx.saveReviews({operation_id:'later-paper-edit-0001',changes:[{pmid:'1',status:'unreviewed',note:'later',expected_version:1}]});
  e.ctx.saveIssueReview({issue_key:key,operation_id:'later-issue-reopen-01',status:'in_progress',expected_version:1,content_version:result.issue.content_version});
  const changed=e.writes();const latest=e.ctx.saveAndCompleteIssue(e.request);
  assert.equal(latest.completion_recorded,true);assert.equal(latest.completed,false);
  assert.equal(latest.issue.status,'in_progress');assert.equal(latest.reviews[0].review.status,'unreviewed');
  assert.equal(latest.reviews[0].review.note,'later');assert.equal(e.writes(),changed);
});

test('invalid completion binding or paper changes cannot append either event',()=>{
  for(const mutate of [
    r=>{r.expected_version=9;},r=>{r.content_version='wrong';},r=>{r.operation_id='invalid';},
    r=>{r.review_operation_id=r.operation_id;},r=>{r.changes[0].expected_version=9;},
    r=>{r.changes[0].note='x'.repeat(2001);},r=>{r.changes[0].pmid='10';},
    r=>{r.changes.push({...r.changes[0]});},r=>{r.changes[0].status='invalid';},
  ]){
    const e=setup();mutate(e.request);assert.throws(()=>e.ctx.saveAndCompleteIssue(e.request));assert.equal(e.writes(),0);
  }
  const e=setup();e.ctx.saveAndCompleteIssue(e.request);const n=e.writes();
  assert.throws(()=>e.ctx.saveAndCompleteIssue({...e.request,changes:[{...e.request.changes[0],note:'different'}]}),/操作ID/);
  assert.throws(()=>e.ctx.saveAndCompleteIssue({...e.request,review_operation_id:'other-operation-0001'}),/操作ID/);
  assert.equal(e.writes(),n);
});

test('flush and readback failures preserve exact stage IDs and recover without duplicates',()=>{
  for(const stage of ['paper-flush','completion-flush','paper-readback','completion-readback']){
    let enabled=true;
    const e=setup({onRead:(name,t,r)=>{
      if(enabled&&r.row>1&&((stage==='paper-readback'&&name==='Reviews')||(stage==='completion-readback'&&name==='IssueReviews')))throw new Error('readback unavailable');
    }});
    let flushes=0;e.ctx.SpreadsheetApp.flush=()=>{flushes++;if(enabled&&((stage==='paper-flush'&&flushes===1)||(stage==='completion-flush'&&flushes===2)))throw new Error('flush unavailable');};
    if(stage.startsWith('paper'))assert.throws(()=>e.ctx.saveAndCompleteIssue(e.request),/unavailable/);
    else{const partial=e.ctx.saveAndCompleteIssue(e.request);assert.equal(partial.saved,true);assert.equal(partial.completion_recorded,false);}
    enabled=false;const retried=e.ctx.saveAndCompleteIssue(e.request);
    assert.equal(retried.completed,true,stage);assert.equal(e.tables.Reviews.length,2);assert.equal(e.tables.IssueReviews.length,2);
  }
});

test('readback-confirmed writes stay confirmed if a following revision check detects Python sync',()=>{
  for(const stage of ['Reviews','IssueReviews']){
    let enabled=true;
    const e=setup({onRead:(name,t,r)=>{if(enabled&&name===stage&&r.row>1)t.Settings.find(row=>row[0]==='revision')[1]='changed';}});
    const partial=e.ctx.saveAndCompleteIssue(e.request);
    assert.equal(partial.saved,true);assert.equal(partial.needs_reload,true);
    assert.equal(partial.reviews[0].review.status,'want_fulltext');
    assert.equal(partial.completion_recorded,stage==='IssueReviews');
    assert.equal(e.tables.Reviews.length,2);assert.equal(e.tables.IssueReviews.length,stage==='IssueReviews'?2:1);
    enabled=false;const retry=e.ctx.saveAndCompleteIssue(e.request);
    assert.equal(retry.completed,true);assert.equal(e.tables.Reviews.length,2);assert.equal(e.tables.IssueReviews.length,2);
  }
});

test('partial success cannot complete a delivery after content changed, and fresh edits use new IDs',()=>{
  const e=setup();const complete=e.ctx.saveIssueReviewInContext_;
  e.ctx.saveIssueReviewInContext_=()=>{throw new Error('completion unavailable');};
  const partial=e.ctx.saveAndCompleteIssue(e.request);assert.equal(partial.saved,true);assert.equal(partial.completed,false);
  e.ctx.saveIssueReviewInContext_=complete;
  e.tables.Issues[1][5]='new content';e.tables.Settings.find(r=>r[0]==='revision')[1]='two';
  const retry=e.ctx.saveAndCompleteIssue(e.request);
  assert.equal(retry.saved,true);assert.equal(retry.completed,false);assert.equal(e.tables.IssueReviews.length,1);
  const issue=e.ctx.listIssuePapers({issue_key:key}).issue;
  const fresh=e.ctx.saveAndCompleteIssue({...e.request,operation_id:'new-completion-0001',review_operation_id:'new-paper-save-0001',
    content_version:issue.content_version,changes:[{pmid:'1',status:'read',note:'new',expected_version:1}]});
  assert.equal(fresh.completed,true);assert.equal(e.tables.Reviews.length,3);
});

test('legacy ledgers and completion without new paper changes retain the workflow',()=>{
  const e=setup({indexed:false,candidates:false});
  assert.equal(e.ctx.saveAndCompleteIssue(e.request).completed,true);
  const normal=setup();normal.ctx.saveReviews({operation_id:normal.request.review_operation_id,issue_key:key,changes:normal.request.changes});
  assert.equal(normal.ctx.saveAndCompleteIssue({...normal.request,changes:[],review_operation_id:''}).completed,true);
  assert.equal(normal.tables.Reviews.length,2);
});
