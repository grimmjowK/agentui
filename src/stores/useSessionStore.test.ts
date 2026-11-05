import assert from 'node:assert/strict';
import test from 'node:test';

import { computeMerged, type NormalizedMessage } from './useSessionStore';

const msg = (id: string, ts: string, extra: Partial<NormalizedMessage>): NormalizedMessage => ({
  id, sessionId: 's', timestamp: `2026-11-03T11:42:${ts}Z`, provider: 'claude', kind: 'text', ...extra,
});

test('未被服务端认领的用户提问按时间排在回答前面，旧错误不沉底', () => {
  const server = [
    msg('a1', '10', { role: 'assistant', content: 'old answer' }),
    msg('a2', '30', { role: 'assistant', content: 'new answer' }),
  ];
  const realtime = [
    msg('err', '15', { kind: 'error', content: 'some unrelated failure happened here' }),
    msg('local_u', '20', { role: 'user', content: 'skill chip text' }),
  ];
  assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['a1', 'err', 'local_u', 'a2']);
});

test('已以助手正文出现过的 API 错误不再重复渲染', () => {
  const apiError = 'API Error: 422 {"detail":"supplier response failed"}';
  const server = [msg('a1', '44', { role: 'assistant', content: apiError })];
  const realtime = [msg('err', '45', { kind: 'error', content: `Claude Code returned an error result: ${apiError}` })];
  assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['a1']);
  // 刷新前：两条都还在 realtime 里
  assert.deepEqual(computeMerged([], [...server, ...realtime]).map((m) => m.id), ['a1']);
});

test('重试后同样的错误不跨轮次去重', () => {
  const err = 'Connection failed: service unavailable';
  const realtime = [
    msg('u1', '10', { role: 'user', content: 'q1' }),
    msg('e1', '11', { kind: 'error', content: err }),
    msg('u2', '20', { role: 'user', content: 'q2' }),
    msg('e2', '21', { kind: 'error', content: err }),
  ];
  assert.deepEqual(computeMerged([], realtime).map((m) => m.id), ['u1', 'e1', 'u2', 'e2']);
});

test('无效时间戳只影响自身，后续有效消息仍按时间插入', () => {
  const server = [
    msg('a1', '10', { role: 'assistant', content: 'a1' }),
    msg('a2', '30', { role: 'assistant', content: 'a2' }),
  ];
  const realtime = [
    { ...msg('e1', '00', { kind: 'error', content: 'some unrelated failure happened here' }), timestamp: 'invalid' },
    msg('local_u', '20', { role: 'user', content: 'q' }),
  ];
  assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['a1', 'local_u', 'a2', 'e1']);
});

test('id 契約：執行中拉到部分歷史時，同 id 的即時訊息不重複，且即時的工具結果疊加上去', () => {
  // 歷史只寫到第一則回覆與尚無輸出的工具呼叫；即時流中間夾著狀態通知，相鄰去重無法生效
  const server = [
    msg('local_q', '10', { role: 'user', content: 'run it' }),
    msg('msg_1', '11', { role: 'assistant', content: 'I will run it.' }),
    msg('call_1', '12', { kind: 'tool_use', toolId: 'call_1', toolName: 'Bash', toolInput: { command: 'ls' } }),
  ];
  const realtime = [
    msg('msg_1', '13', { role: 'assistant', content: 'I will run it.' }),
    msg('note', '14', { kind: 'error', content: 'rate limited, retrying in a moment' }),
    msg('call_1', '15', {
      kind: 'tool_use', toolId: 'call_1', toolName: 'Bash', toolInput: { command: 'ls' },
      toolResult: { content: 'a.txt', isError: false },
    }),
    msg('msg_2', '16', { role: 'assistant', content: 'Done.' }),
  ];
  const merged = computeMerged(server, realtime);
  assert.deepEqual(merged.map((m) => m.id), ['local_q', 'msg_1', 'call_1', 'note', 'msg_2']);
  assert.equal(merged[2].toolResult?.content, 'a.txt');
  assert.equal(merged[2].timestamp, server[2].timestamp);
});

test('id 契約：即時的精簡 toolInput 不能覆蓋歷史的完整內容，只補歷史缺的 toolResult', () => {
  const server = [msg('agy_tool_2', '10', {
    kind: 'tool_use', toolId: 'agy_tool_2', toolName: 'Write', toolInput: { file_path: '/a.py', content: 'print(1)\n' },
  })];
  const realtime = [msg('agy_tool_2', '11', {
    kind: 'tool_use', toolId: 'agy_tool_2', toolName: 'Write', toolInput: { file_path: '/a.py', content: '' },
    toolResult: { content: 'Created file.', isError: false },
  })];
  const [merged] = computeMerged(server, realtime);
  assert.deepEqual(merged.toolInput, { file_path: '/a.py', content: 'print(1)\n' });
  assert.equal(merged.toolResult?.content, 'Created file.');
});

test('同輪重試成功後，時間戳晚於 PLANNER_RESPONSE 起點的暫時性 API error (attempt N) 不掛在結尾', () => {
  const server = [
    msg('u1', '10', { role: 'user', content: '你好' }),
    // PLANNER_RESPONSE 的 created_at 是步驟開始時間（早於 attempt 2 失敗時間）
    msg('agy_s_step_1', '12', { role: 'assistant', content: '這是重試成功後的完整回答' }),
  ];
  const realtime = [
    msg('err_retry', '15', {
      kind: 'error',
      content: 'API error (attempt 2): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": read: connection reset by peer',
    }),
  ];
  assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['u1', 'agy_s_step_1']);
});
