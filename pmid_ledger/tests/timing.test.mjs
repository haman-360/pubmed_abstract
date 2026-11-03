import test from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './environment.mjs';
const request = (method, arg) => ({ method, arg, request_id: 'timing-request-0001' });
const save = {
  issue_key: '["issue1","感染症"]', operation_id: 'timing-save-test-0001',
  changes: [{ pmid: '1', status: 'reviewed_no_fulltext', note: 'PRIVATE NOTE', expected_version: 0 }],
};

test('timing preserves response and read ranges, separates nested spans, and resets between calls', () => {
  const reads = [], e = environment({ indexed: true, candidates: true, cache: new Map(), onRead: (name) => reads.push(name) });
  const baseline = e.plain(e.ctx.listIssues({}));
  reads.length = 0;
  const ordinary = e.plain(e.ctx.listIssues({})), ordinaryReads = [...reads];
  reads.length = 0;
  let clock = 0;
  e.ctx.Date = { now: () => ++clock };
  const result = e.plain(e.ctx.profileLedger(request('listIssues', {})));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, ordinary);
  assert.deepEqual(ordinary, baseline);
  assert.deepEqual(reads, ordinaryReads);
  assert.equal(result.profile.counts.sheet_reads, 4);
  assert.equal(result.profile.counts.cache_hits, 1);
  assert.equal(result.profile.request_id, 'timing-request-0001');
  assert.ok(result.profile.handler_ms <= result.profile.total_ms);
  assert.ok(result.profile.spans.some(s => s.name === 'sheets.open'));
  assert.ok(result.profile.spans.some(s => s.name === 'revision.check'));
  assert.ok(result.profile.spans.every(s => s.elapsed_ms >= s.self_ms && s.self_ms >= 0));
  assert.ok(result.profile.spans.reduce((sum, s) => sum + s.self_ms, 0) <= result.profile.total_ms);
  assert.equal(e.ctx.ledgerTiming_, null);
  assert.equal(e.writes(), 0);
});

test('production timing rejects writes and unknown endpoints even when client protection is bypassed', () => {
  const e = environment({ indexed: true, candidates: true });
  const get = e.ctx.PropertiesService.getScriptProperties;
  e.ctx.PropertiesService.getScriptProperties = () => ({ getProperty: name => name === 'LEDGER_INSTANCE' ? 'production' : get().getProperty(name) });
  for (const method of ['saveReviews', 'saveIssueReview', 'saveAndCompleteIssue']) {
    const result = e.ctx.profileLedger(request(method, save));
    assert.equal(result.ok, false);
    assert.match(result.error, /本番台帳/);
  }
  for (const method of ['authorize_', 'exportData', 'constructor', '__proto__']) {
    assert.equal(e.ctx.profileLedger(request(method, {})).ok, false);
  }
  assert.equal(e.writes(), 0);
});

test('timed TEST saves retain idempotency, conflict checking, flush and readback; metrics omit private data', () => {
  const e = environment({ indexed: true, candidates: true });
  const result = e.plain(e.ctx.profileLedger(request('saveReviews', save)));
  assert.equal(result.ok, true);
  assert.equal(e.writes(), 1);
  assert.ok(result.profile.spans.some(s => s.name === 'lock.wait'));
  assert.ok(result.profile.spans.some(s => s.name === 'sheets.write.Reviews'));
  assert.ok(result.profile.spans.some(s => s.name === 'sheets.flush'));
  assert.ok(result.profile.spans.some(s => s.name === 'sheets.readback.Reviews'));
  assert.equal(result.profile.counts.sheet_reads, 7);
  const telemetry = JSON.stringify(result.profile);
  for (const privateValue of ['PRIVATE NOTE', 'owner@test.invalid', '感染症', 'timing-save-test']) assert.ok(!telemetry.includes(privateValue));
  const retry = e.ctx.profileLedger(request('saveReviews', save));
  assert.equal(retry.ok, true); assert.equal(retry.value.replayed, true); assert.equal(e.writes(), 1);
  const conflict = e.ctx.profileLedger(request('saveReviews', { ...save, operation_id: 'timing-save-conflict-1' }));
  assert.equal(conflict.ok, false); assert.match(conflict.error, /別の画面/);
  assert.equal(e.writes(), 1); assert.equal(e.ctx.ledgerTiming_, null);
});

test('failed read records its timing and auth failure never exposes ledger data', () => {
  const e = environment({ indexed: true, onRead: name => { if (name === 'Reviews') throw new Error('service unavailable'); } });
  const result = e.ctx.profileLedger(request('listIssues', {}));
  assert.equal(result.ok, false);
  assert.ok(result.profile.spans.some(s => s.name === 'sheets.read.Reviews'));
  assert.equal(e.ctx.ledgerTiming_, null);
  const denied = environment({ stranger: true }).ctx.profileLedger(request('listPapers', {}));
  assert.equal(denied.ok, false); assert.equal(denied.value, undefined);
  assert.equal(denied.profile.method, '');
});
