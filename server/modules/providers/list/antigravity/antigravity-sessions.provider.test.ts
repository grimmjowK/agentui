import assert from 'node:assert/strict';
import test from 'node:test';

import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { parseAntigravitySessionPath } from '@/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.js';

const provider = new AntigravitySessionsProvider();

test('normalizeMessage parses text and kind records', () => {
  const [msg] = provider.normalizeMessage(
    { role: 'user', text: 'Hello Antigravity' },
    's-1',
  );
  assert.equal(msg.kind, 'text');
  assert.equal(msg.role, 'user');
  assert.equal(msg.content, 'Hello Antigravity');
  assert.equal(msg.provider, 'antigravity');
});

test('parseAntigravitySessionPath extracts conversation id from brain paths', () => {
  const samplePath = '/Users/username/.gemini/antigravity/brain/d9bc5a72-f456-487a-9724-6db040c4d79a/.system_generated/logs/transcript.jsonl';
  assert.equal(
    parseAntigravitySessionPath(samplePath),
    'd9bc5a72-f456-487a-9724-6db040c4d79a',
  );

  const flatPath = '/Users/username/.gemini/antigravity/brain/session-abc-123/transcript.jsonl';
  assert.equal(
    parseAntigravitySessionPath(flatPath),
    'session-abc-123',
  );

  assert.equal(parseAntigravitySessionPath('/some/other/path.jsonl'), null);
});

test('fetchHistory handles limit: 0 gracefully', async () => {
  const emptyResult = await provider.fetchHistory('any-session-id', { limit: 0 });
  assert.equal(emptyResult.messages.length, 0);
  assert.equal(emptyResult.hasMore, false);
  assert.equal(emptyResult.limit, 0);
});
