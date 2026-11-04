import assert from 'node:assert/strict';
import test from 'node:test';

import { steerRun } from './openai-codex.js';

function run(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  let closed = false;
  const state = {
    userId: 7, turnId: 'turn-1', finished: false, interrupted: false,
    rpc: {
      async request(method: string, params: unknown) {
        calls.push({ method, params });
        if (overrides.rpcError) throw new Error(String(overrides.rpcError));
        return { turnId: 'turn-1' };
      },
      close() { closed = true; },
    },
    ...overrides,
  };
  return { state: state as any, calls, isClosed: () => closed };
}

test('插話以目前的 turnId 作為 expectedTurnId 呼叫 turn/steer', async () => {
  const { state, calls } = run();
  assert.deepEqual(await steerRun(state, 'thread-1', 7, '改用 pnpm'), { ok: true });
  assert.deepEqual(calls, [{ method: 'turn/steer', params: {
    threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: '改用 pnpm', text_elements: [] }],
  } }]);
});

test('前置條件不成立時拒絕，且不呼叫 app-server', async () => {
  const cases: Array<[string, ReturnType<typeof run>, string | number | null, string]> = [
    ['turn 尚未開始', run({ turnId: null }), 7, 'turn_not_started'],
    ['其他使用者', run(), 8, 'not_owner'],
    ['呼叫者缺少 userId', run(), null, 'not_owner'],
    ['已按中斷', run({ interrupted: true }), 7, 'not_running'],
    ['已結束', run({ finished: true }), 7, 'not_running'],
  ];
  for (const [name, { state, calls }, userId, reason] of cases) {
    assert.deepEqual(await steerRun(state, 'thread-1', userId, 'hi'), { ok: false, reason }, name);
    assert.equal(calls.length, 0, name);
  }
  assert.deepEqual(await steerRun(undefined, 'thread-1', 7, 'hi'), { ok: false, reason: 'not_running' });
});

test('app-server 回傳錯誤時只回報失敗，這一輪不受影響', async () => {
  const { state, isClosed } = run({ rpcError: 'expectedTurnId mismatch' });
  assert.deepEqual(await steerRun(state, 'thread-1', 7, 'hi'), { ok: false, reason: 'expectedTurnId mismatch' });
  assert.equal(state.finished, false);
  assert.equal(state.interrupted, false);
  assert.equal(isClosed(), false);
});
