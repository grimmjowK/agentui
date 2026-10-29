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
