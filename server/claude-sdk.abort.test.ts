import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// mock.module 需要 --experimental-test-module-mocks（npm test 已帶上）；沒帶時明確略過
const canMock = typeof mock.module === 'function';

// 假的 SDK query：送出 session id 後一直等，interrupt() 時結束迴圈；mode=throw 時改為拋錯
let mode = 'end';
if (canMock) mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: () => {
      let release!: () => void;
      const stopped = new Promise<void>((r) => { release = r; });
      setTimeout(() => release(), 5000).unref();  // 測試失敗時不要讓迴圈一直掛著
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: `claude-${mode}` };
          await stopped;
          if (mode === 'throw') throw new Error('Claude Code process aborted by user');
        },
        // 迴圈在 interrupt 後延遲結束，讓同一會話的新一輪有機會先登記
        interrupt: async () => { setTimeout(release, 100); },
      };
    },
  },
});

const { queryClaudeSDK, abortClaudeSDKSession, isClaudeSDKSessionActive } = await import('./claude-sdk.js');

for (const m of ['end', 'throw']) {
  test(`中斷後底層不再送出 complete/error（SDK 迴圈${m === 'end' ? '正常結束' : '拋錯'}）`, { skip: !canMock && '需要 --experimental-test-module-mocks' }, async () => {
    mode = m;
    const messages: any[] = [];
    const writer = { isWebSocketWriter: true, userId: 1, send: (msg: any) => messages.push(msg), setSessionId: () => {} };
    const done = queryClaudeSDK('hi', { cwd: process.cwd() }, writer);
    while (!messages.some((msg) => msg.kind === 'session_created')) await new Promise((r) => setTimeout(r, 10));
    assert.equal(await abortClaudeSDKSession(`claude-${m}`), true);
    await done;
    assert.deepEqual(messages.filter((msg) => msg.kind === 'complete' || msg.kind === 'error'), []);
  });
}

test('中斷後立刻在同一會話開新一輪：舊迴圈收尾不會刪掉新一輪的登記', { skip: !canMock && '需要 --experimental-test-module-mocks' }, async () => {
  mode = 'end';
  const writer = () => {
    const messages: any[] = [];
    return { messages, w: { isWebSocketWriter: true, userId: 1, send: (msg: any) => messages.push(msg), setSessionId: () => {} } };
  };
  const a = writer();
  const first = queryClaudeSDK('hi', { cwd: process.cwd() }, a.w);
  while (!a.messages.some((msg) => msg.kind === 'session_created')) await new Promise((r) => setTimeout(r, 10));
  assert.equal(await abortClaudeSDKSession('claude-end'), true);
  const b = writer();
  const second = queryClaudeSDK('again', { cwd: process.cwd(), sessionId: 'claude-end' }, b.w);
  await first;
  assert.equal(isClaudeSDKSessionActive('claude-end'), true);
  assert.equal(await abortClaudeSDKSession('claude-end'), true);
  await second;
});
