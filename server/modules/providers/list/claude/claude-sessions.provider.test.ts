import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();

test('normalizeMessage surfaces [Request interrupted as an isInterrupted user message', () => {
  const [msg] = provider.normalizeMessage(
    { message: { role: 'user', content: '[Request interrupted by user]' } },
    's1'
  );
  assert.equal(msg.kind, 'text');
  assert.equal(msg.role, 'user');
  assert.equal(msg.isInterrupted, true);
});

test('normalizeMessage still drops <system-reminder> and Caveat: content', () => {
  assert.deepEqual(
    provider.normalizeMessage({ message: { role: 'user', content: '<system-reminder>foo</system-reminder>' } }, 's1'),
    []
  );
  assert.deepEqual(
    provider.normalizeMessage({ message: { role: 'user', content: 'Caveat: bar' } }, 's1'),
    []
  );
});

test('normalizeMessage renders whitelisted attachment sub-types', () => {
  const [file] = provider.normalizeMessage(
    { type: 'attachment', attachment: { type: 'file', filename: '/tmp/foo.py' } },
    's1'
  );
  assert.equal(file.attachmentKind, 'file');
  assert.equal(file.attachmentPath, '/tmp/foo.py');

  const [skills] = provider.normalizeMessage(
    { type: 'attachment', attachment: { type: 'invoked_skills', skills: [{ name: 'popo-doc' }, { name: 'km-ask' }] } },
    's1'
  );
  assert.equal(skills.attachmentDetail, 'popo-doc, km-ask');
});

test('normalizeMessage drops noisy and unrecognized attachment sub-types without throwing', () => {
  assert.deepEqual(
    provider.normalizeMessage({ type: 'attachment', attachment: { type: 'hook_success' } }, 's1'),
    []
  );
  assert.deepEqual(
    provider.normalizeMessage({ type: 'attachment', attachment: { type: 'totally_new_thing' } }, 's1'),
    []
  );
  assert.deepEqual(provider.normalizeMessage({ type: 'attachment' }, 's1'), []);
});

test('normalizeMessage surfaces only the compact_boundary system subtype', () => {
  const [boundary] = provider.normalizeMessage(
    { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' },
    's1'
  );
  assert.equal(boundary.isCompactBoundary, true);

  assert.deepEqual(
    provider.normalizeMessage({ type: 'system', subtype: 'stop_hook_summary' }, 's1'),
    []
  );
});
