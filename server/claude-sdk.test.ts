import assert from 'node:assert/strict';
import test from 'node:test';

import { getPendingApprovals, resolveToolApproval, waitForToolApproval } from './claude-sdk.js';

const pending = (requestId: string, userId: unknown, sessionId = 's1') => waitForToolApproval(requestId, {
  timeoutMs: 0,
  metadata: { _userId: userId, _sessionId: sessionId, _toolName: 'Bash', _input: {}, _receivedAt: new Date() },
});

test('其他使用者無法審批，請求仍等待中；擁有者審批後才結束', async () => {
  const decision = pending('r-other', 7);
  assert.equal(resolveToolApproval('r-other', 8, { allow: true }), false);
  assert.equal(getPendingApprovals(7, 's1').length, 1);
  assert.equal(resolveToolApproval('r-other', '7', { allow: false }), true);
  assert.deepEqual(await decision, { allow: false });
  assert.equal(getPendingApprovals(7).length, 0);
});

test('呼叫者缺少 userId 時拒絕', async () => {
  const decision = pending('r-anon', 7);
  assert.equal(resolveToolApproval('r-anon', null, { allow: true }), false);
  assert.equal(resolveToolApproval('r-anon', undefined, { allow: true }), false);
  assert.equal(resolveToolApproval('r-anon', 7, { allow: true }), true);
  await decision;
});

test('getPendingApprovals 只列出該使用者的項目，可依會話過濾', async () => {
  const decisions = [pending('a', 1, 's1'), pending('b', 1, 's2'), pending('c', 2, 's1')];
  assert.deepEqual(getPendingApprovals(1).map((item: any) => item.requestId).sort(), ['a', 'b']);
  assert.deepEqual(getPendingApprovals(1, 's2').map((item: any) => [item.requestId, item.provider]), [['b', 'claude']]);
  assert.deepEqual(getPendingApprovals(null), []);
  resolveToolApproval('a', 1, {}); resolveToolApproval('b', 1, {}); resolveToolApproval('c', 2, {});
  await Promise.all(decisions);
});

test('逾時時觸發 onCancel(timeout)（送出 permission_cancelled 的來源）並回傳 null', async () => {
  const reasons: string[] = [];
  const decision = await waitForToolApproval('r-timeout', {
    timeoutMs: 10, onCancel: (reason: string) => reasons.push(reason),
    metadata: { _userId: 1, _sessionId: 's1' },
  });
  assert.equal(decision, null);
  assert.deepEqual(reasons, ['timeout']);
  assert.equal(getPendingApprovals(1).length, 0);
});
