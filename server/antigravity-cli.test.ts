import assert from 'node:assert/strict';
import test from 'node:test';

import { AntigravityResponseHandler } from './antigravity-cli.js';

test('AntigravityResponseHandler parses stream deltas and text completion', () => {
  const messages: any[] = [];
  const writer = {
    isWebSocketWriter: true,
    send: (msg: any) => messages.push(msg),
  };

  const handler = new AntigravityResponseHandler('test-session', writer);

  // Send delta lines
  handler.handleChunk(Buffer.from('{"type":"delta","delta":"Hello "}\n'));
  handler.handleChunk(Buffer.from('{"type":"delta","delta":"world!"}\n'));
  handler.handleChunk(Buffer.from('{"type":"text","content":"Hello world!"}\n'));

  assert.equal(messages.length, 4); // 2 deltas, 1 stream_end, 1 text
  assert.equal(messages[0].kind, 'stream_delta');
  assert.equal(messages[0].content, 'Hello ');
  assert.equal(messages[1].kind, 'stream_delta');
  assert.equal(messages[1].content, 'world!');
  assert.equal(messages[2].kind, 'stream_end');
  assert.equal(messages[3].kind, 'text');
  assert.equal(messages[3].content, 'Hello world!');
});

test('AntigravityResponseHandler parses tool use and tool result', () => {
  const messages: any[] = [];
  const writer = {
    isWebSocketWriter: true,
    send: (msg: any) => messages.push(msg),
  };

  const handler = new AntigravityResponseHandler('test-session', writer);

  handler.handleChunk(
    Buffer.from('{"type":"tool_use","name":"run_command","args":{"command":"ls"}}\n'),
  );
  handler.handleChunk(
    Buffer.from('{"type":"tool_result","toolId":"call_123","content":"file1.txt","isError":false}\n'),
  );

  assert.equal(messages.length, 2);
  assert.equal(messages[0].kind, 'tool_use');
  assert.equal(messages[0].toolName, 'run_command');
  assert.equal(messages[1].kind, 'tool_result');
  assert.equal(messages[1].content, 'file1.txt');
});

test('AntigravityResponseHandler falls back to raw text lines and flushes stream_end', () => {
  const messages: any[] = [];
  const writer = {
    isWebSocketWriter: true,
    send: (msg: any) => messages.push(msg),
  };

  const handler = new AntigravityResponseHandler('test-session', writer);
  handler.handleChunk(Buffer.from('Thinking about the solution...\nStep 1 complete\n'));
  handler.flush();

  const kinds = messages.map((m) => m.kind);
  assert.ok(kinds.includes('stream_delta'));
  assert.ok(kinds.includes('stream_end'));
  assert.ok(kinds.includes('text'));
});

test('native agy events adopt the ID before streaming and finish text only once', () => {
  const messages: any[] = [];
  const adopted: string[] = [];
  const writer = { isWebSocketWriter: true, send: (msg: any) => messages.push(msg) };
  const handler = new AntigravityResponseHandler(null, writer, (id: string) => adopted.push(id));
  const events = [
    { event: 'init', conversation_id: 'native-id', init: { cwd: '/workspace' } },
    { event: 'step_update', step_update: { conversation_id: 'native-id', step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: '你好' } },
    { event: 'result', result: { conversation_id: 'native-id', status: 'SUCCESS', response: '你好' } },
  ];
  // Split on every byte, including in the middle of multibyte UTF-8 characters.
  for (const byte of Buffer.from(events.map((event) => JSON.stringify(event)).join('\n'))) {
    handler.handleChunk(Buffer.from([byte]));
  }
  handler.flush();
  assert.deepEqual(adopted, ['native-id']);
  assert.equal(messages[0].kind, 'session_created');
  assert.ok(messages.every((msg) => msg.sessionId === 'native-id'));
  assert.deepEqual(messages.filter((msg) => msg.kind === 'text').map((msg) => msg.content), ['你好']);
  assert.equal(messages.filter((msg) => msg.kind === 'stream_end').length, 1);
});

test('result-only responses establish session identity and preserve errors', () => {
  const messages: any[] = [];
  const handler = new AntigravityResponseHandler(null, { isWebSocketWriter: true, send: (msg: any) => messages.push(msg) });
  handler.handleJsonEvent({ event: 'result', result: { conversation_id: 'failed-id', status: 'ERROR', error: 'Permission denied' } });
  handler.flush();
  assert.equal(messages[0].kind, 'session_created');
  assert.equal(handler.error, 'Permission denied');
  assert.equal(messages.filter((msg) => msg.kind === 'text').length, 0);
});

test('findPermissionDeniedNotice 認得 headless 自動拒絕審批的 stderr', async () => {
  const { findPermissionDeniedNotice } = await import('./antigravity-cli.js');
  const stderr = 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)).\n';
  assert.match(findPermissionDeniedNotice(stderr) ?? '', /auto-denied/);
  assert.equal(findPermissionDeniedNotice('some other warning\n'), null);
  assert.equal(findPermissionDeniedNotice(''), null);
});

test('id 契約：每段回覆各自收尾，stream_end 帶與歷史相同的 id，result 不重送已串流的回覆', () => {
  const messages: any[] = [];
  const handler = new AntigravityResponseHandler('sid', { isWebSocketWriter: true, send: (msg: any) => messages.push(msg) });
  const step = (s: object) => handler.handleJsonEvent({ event: 'step_update', step_update: { conversation_id: 'sid', ...s } });
  step({ step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: '先跑一下' });
  step({ step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls' } } });
  step({ step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { output: 'a.txt' } });
  step({ step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: '完成' });
  handler.handleJsonEvent({ event: 'result', result: { conversation_id: 'sid', status: 'SUCCESS', response: '完成' } });
  handler.flush();

  const ends = messages.filter((m) => m.kind === 'stream_end').map((m) => m.messageId);
  assert.deepEqual(ends, ['agy_sid_step_1', 'agy_sid_step_3']);
  const texts = messages.filter((m) => m.kind === 'text').map((m) => [m.id, m.content]);
  assert.deepEqual(texts, [['agy_sid_step_1', '先跑一下'], ['agy_sid_step_3', '完成']]);
  assert.equal(messages.find((m) => m.kind === 'tool_use')?.id, 'agy_tool_2');
});

test('id 契約：agent_response 一到 DONE 就收尾，不等到下一段（背景等待期間串流佔位不能殘留）', () => {
  // agy 1.5.0 實測順序：文字步驟 DONE 後接 system_message，下一段文字要等背景指令跑完才來
  const messages: any[] = [];
  const handler = new AntigravityResponseHandler('sid', { isWebSocketWriter: true, send: (msg: any) => messages.push(msg) });
  const step = (s: object) => handler.handleJsonEvent({ event: 'step_update', step_update: { conversation_id: 'sid', ...s } });
  step({ step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: '已在背景啟動，' });
  step({ step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: '等待完成\n' });
  assert.deepEqual(messages.filter((m) => m.kind === 'stream_end').map((m) => m.messageId), ['agy_sid_step_3']);
  step({ step_index: 4, step_type: 'system_message', state: 'DONE' });
  step({ step_index: 5, step_type: 'agent_response', state: 'ACTIVE', text_delta: '下一段' });
  handler.flush();
  assert.deepEqual(messages.filter((m) => m.kind === 'text').map((m) => [m.id, m.content]), [
    ['agy_sid_step_3', '已在背景啟動，等待完成\n'],
    ['agy_sid_step_5', '下一段'],
  ]);
});
