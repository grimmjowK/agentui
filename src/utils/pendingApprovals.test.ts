import assert from 'node:assert/strict';
import test from 'node:test';

import { applyApprovalEvent, isEventForSession } from './pendingApprovals';

const request = (requestId: string, sessionId: string | null) => ({ requestId, sessionId, toolName: 'Bash' });

test('看著 S2 時 S1 請求審批：池加入 S1 的項目，但不屬於目前會話', () => {
  const pool = applyApprovalEvent([], { kind: 'permission_request', requestId: 'r1', sessionId: 'S1', toolName: 'Bash', provider: 'claude' });
  assert.deepEqual(pool.map((r) => [r.requestId, r.sessionId]), [['r1', 'S1']]);
  assert.equal(isEventForSession('S1', ['S2']), false);
  assert.equal(isEventForSession('S2', ['S2']), true);
});

test('看著執行中的 S2 時 S1 結束：只清掉 S1 的項目，且不屬於目前會話', () => {
  const pool = [request('r1', 'S1'), request('r2', 'S2')];
  const next = applyApprovalEvent(pool, { kind: 'complete', sessionId: 'S1' });
  assert.deepEqual(next.map((r) => r.requestId), ['r2']);
  assert.equal(isEventForSession('S1', ['S2', null]), false);
});

test('沒有 sessionId 的事件視為目前會話（新會話尚未取得 id）', () => {
  assert.equal(isEventForSession(undefined, ['S2']), true);
  assert.equal(isEventForSession(null, [null]), true);
});

test('pending-permissions-response：帶 sessionId 只替換該會話，不帶則全量替換', () => {
  const pool = [request('r1', 'S1'), request('r2', 'S2')];
  const scoped = applyApprovalEvent(pool, { type: 'pending-permissions-response', sessionId: 'S1', data: [request('r3', 'S1')] });
  assert.deepEqual(scoped.map((r) => r.requestId).sort(), ['r2', 'r3']);
  const full = applyApprovalEvent(pool, { type: 'pending-permissions-response', data: [request('r9', 'S3')] });
  assert.deepEqual(full.map((r) => r.requestId), ['r9']);
});

test('permission_cancelled 依 requestId 移除；重複的請求不重複加入；session_created 補上 sessionId', () => {
  let pool = applyApprovalEvent([], { kind: 'permission_request', requestId: 'r1', sessionId: null });
  assert.equal(applyApprovalEvent(pool, { kind: 'permission_request', requestId: 'r1', sessionId: null }), pool);
  pool = applyApprovalEvent(pool, { kind: 'session_created', newSessionId: 'S9' });
  assert.equal(pool[0].sessionId, 'S9');
  assert.deepEqual(applyApprovalEvent(pool, { kind: 'permission_cancelled', requestId: 'r1' }), []);
});

test('complete 帶 actualSessionId 時兩個 id 的項目都清掉；不相關的事件不改變池', () => {
  const pool = [request('r1', 'temp'), request('r2', 'real'), request('r3', 'other')];
  assert.deepEqual(applyApprovalEvent(pool, { kind: 'complete', sessionId: 'temp', actualSessionId: 'real' }).map((r) => r.requestId), ['r3']);
  assert.equal(applyApprovalEvent(pool, { kind: 'text', sessionId: 'S1' }), pool);
});
