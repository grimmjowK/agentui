import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// mock.module 需要 --experimental-test-module-mocks（npm test 已帶上）；沒帶時明確略過
const canMock = typeof mock.module === 'function';

// 假的 SDK：消化第一則輸入後回傳指定的 result（SDK 對錯誤 result 不會拋錯）
let result: Record<string, unknown> = {};
let assistantText = '';
if (canMock) mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: ({ prompt }: { prompt: AsyncIterable<{ uuid: string }> }) => ({
      async *[Symbol.asyncIterator]() {
        const first = (await prompt[Symbol.asyncIterator]().next()).value;
        yield { type: 'system', subtype: 'init', session_id: 'claude-result-error' };
        if (assistantText) {
          yield { type: 'assistant', session_id: 'claude-result-error', parent_tool_use_id: null,
            message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } };
        }
        yield { type: 'result', session_id: 'claude-result-error', user_message_uuids: [first.uuid], ...result };
      },
      interrupt: async () => {},
    }),
  },
});

const { queryClaudeSDK } = await import('./claude-sdk.js');

async function run() {
  const messages: any[] = [];
  const writer = { isWebSocketWriter: true, userId: 1, send: (msg: any) => messages.push(msg), setSessionId: () => {} };
  await queryClaudeSDK('hi', { cwd: process.cwd() }, writer);
  return messages.filter((msg) => msg.kind === 'complete' || msg.kind === 'error');
}

const skip = !canMock && '需要 --experimental-test-module-mocks';

test('錯誤 result（error_during_execution）回報為 error，不是成功的 complete', { skip }, async () => {
  result = { subtype: 'error_during_execution', is_error: true, errors: ['tool crashed'] };
  assistantText = '';
  const terminal = await run();
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].kind, 'error');
  assert.equal(terminal[0].content, 'tool crashed');
});

test('錯誤已以助理文字顯示時改送 exitCode 1 的 complete，不重複錯誤泡泡', { skip }, async () => {
  result = { subtype: 'success', is_error: true, result: 'API Error: 500 overloaded' };
  assistantText = 'API Error: 500 overloaded';
  const terminal = await run();
  assert.deepEqual(terminal.map((m) => [m.kind, m.exitCode]), [['complete', 1]]);
});

test('成功 result 照常送出 exitCode 0 的 complete', { skip }, async () => {
  result = { subtype: 'success', is_error: false, result: 'ok' };
  assistantText = '';
  const terminal = await run();
  assert.deepEqual(terminal.map((m) => [m.kind, m.exitCode]), [['complete', 0]]);
});
