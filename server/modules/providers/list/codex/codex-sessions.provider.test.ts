import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexSessionsProvider, isCodexInterruptedText } from '@/modules/providers/list/codex/codex-sessions.provider.js';

const provider = new CodexSessionsProvider();

test('isCodexInterruptedText recognizes turn abort markers', () => {
  assert.equal(isCodexInterruptedText('<turn_aborted>'), true);
  assert.equal(isCodexInterruptedText('  <turn_aborted> mid turn'), true);
  assert.equal(isCodexInterruptedText('Conversation interrupted - use /feedback if something went wrong'), true);
  assert.equal(isCodexInterruptedText('Normal user message'), false);
});

test('normalizeMessage surfaces <turn_aborted> as an isInterrupted user message', () => {
  const [msg] = provider.normalizeMessage(
    { message: { role: 'user', content: '<turn_aborted>' } },
    's1'
  );
  assert.equal(msg.kind, 'text');
  assert.equal(msg.role, 'user');
  assert.equal(msg.isInterrupted, true);
});

test('normalizeMessage normalizes tool_result with isError', () => {
  const [msg] = provider.normalizeMessage(
    { type: 'tool_result', toolCallId: 'call_1', output: 'curl: (56) 403 Forbidden', isError: true },
    's1'
  );
  assert.equal(msg.kind, 'tool_result');
  assert.equal(msg.isError, true);
  assert.equal(msg.content, 'curl: (56) 403 Forbidden');
});

test('normalizeMessage passes through codex-item-mapper output', () => {
  const [msg] = provider.normalizeMessage(
    {
      type: 'mapped',
      timestamp: '2026-11-01T00:00:00.000Z',
      mapped: { kind: 'tool_use', toolId: 'call_1', toolName: 'Bash', toolInput: { command: 'ls' } },
    },
    's1'
  );
  assert.equal(msg.kind, 'tool_use');
  assert.equal(msg.toolName, 'Bash');
  assert.equal(msg.toolId, 'call_1');
  assert.equal(msg.provider, 'codex');
  assert.equal(msg.sessionId, 's1');
});
