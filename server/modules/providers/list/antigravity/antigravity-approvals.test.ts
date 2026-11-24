import assert from 'node:assert/strict';
import test from 'node:test';

import { AntigravityApprovals } from './antigravity-approvals.js';

const options = [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }];
const toolCall = { name: 'run_command', args: { CommandLine: 'ls -la' } };

function setup() {
  const approvals = new AntigravityApprovals();
  const notes: any[] = [];
  const add = (userId: string | number | null = 7, instanceId = 'i1') => approvals.add({
    userId, sessionId: 's1', instanceId, toolCall, options, notify: (m) => notes.push(m),
  });
  return { approvals, notes, add };
}

test('新增後送出映射過的 permission_request，發起者允許後回覆 allow', async () => {
  const { approvals, notes, add } = setup();
  const pending = add();
  const request = notes[0];
  assert.equal(request.kind, 'permission_request');
  assert.equal(request.toolName, 'Bash');
  assert.deepEqual(request.input, { command: 'ls -la' });
  assert.deepEqual(request.context.decisions, ['allow', 'deny']);
  assert.ok(request.context.expiresAt > Date.now());
  assert.equal(approvals.list(7)[0].requestId, request.requestId);
  assert.equal(approvals.decide(request.requestId, 7, 'allow'), true);
  assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'allow' } });
  assert.equal(approvals.list(7).length, 0);
});

test('非發起者、缺少 userId、決定不在選項內都被拒', () => {
  const { approvals, notes, add } = setup();
  void add();
  const { requestId } = notes[0];
  assert.equal(approvals.decide(requestId, 8, 'allow'), false);
  assert.equal(approvals.decide(requestId, null, 'allow'), false);
  assert.equal(approvals.decide(requestId, 7, 'allow_always'), false);
  assert.equal(approvals.list(8).length, 0, '列出只含該使用者');
  assert.equal(approvals.list(7).length, 1);
});

test('沒有使用者身分的請求直接拒絕，不進池', async () => {
  const { approvals, add } = setup();
  assert.deepEqual(await add(null), { outcome: { outcome: 'selected', optionId: 'deny' } });
  assert.equal(approvals.list(7).length, 0);
});

test('逾時回覆 deny 並送 permission_cancelled', async (t) => {
  // 真實執行由子行程維持事件迴圈；測試替身需自行維持到逾時完成。
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const previous = process.env.ANTIGRAVITY_APPROVAL_TIMEOUT_MS;
  process.env.ANTIGRAVITY_APPROVAL_TIMEOUT_MS = '20';
  try {
    const { notes, add } = setup();
    assert.deepEqual(await add(), { outcome: { outcome: 'selected', optionId: 'deny' } });
    assert.equal(notes.at(-1).kind, 'permission_cancelled');
    assert.equal(notes.at(-1).reason, 'expired');
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_APPROVAL_TIMEOUT_MS;
    else process.env.ANTIGRAVITY_APPROVAL_TIMEOUT_MS = previous;
  }
});

test('清除執行個體時回覆已取消，只影響該執行個體', async () => {
  const { approvals, notes, add } = setup();
  const a = add(7, 'i1');
  void add(7, 'i2');
  assert.equal(approvals.hasPending('i1'), true);
  approvals.clearInstance('i1');
  assert.deepEqual(await a, { outcome: { outcome: 'cancelled' } });
  assert.equal(notes.filter((m) => m.kind === 'permission_cancelled' && m.reason === 'cancelled').length, 1);
  assert.equal(approvals.hasPending('i2'), true);
});
