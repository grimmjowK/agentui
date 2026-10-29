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

test('normalizeMessage normalizes command_execution and sets isError on non-zero exit code', () => {
  const [msg] = provider.normalizeMessage(
    {
      type: 'item',
      itemType: 'command_execution',
      command: 'curl -L https://api.github.com/test',
      status: 'failed',
      exitCode: 56,
      output: 'curl: (56) The requested URL returned error: 403',
    },
    's1'
  );
  assert.equal(msg.kind, 'tool_use');
  assert.equal(msg.toolName, 'Bash');
  assert.equal(msg.toolResult?.isError, true);
  assert.match(msg.toolResult?.content || '', /403/);
});
