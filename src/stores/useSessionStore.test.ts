import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyLogMessage,
  replaceWithFetched,
  type NormalizedMessage,
  type SessionSlot,
} from './useSessionStore';

function emptySlot(): SessionSlot {
  return {
    serverMessages: [],
    realtimeMessages: [],
    merged: [],
    _lastServerRef: [],
    _lastRealtimeRef: [],
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    nextBeforeSeq: null,
    tokenUsage: null,
  };
}

function message(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'codex',
    kind: 'text',
    role: 'assistant',
    content: 'hello',
    ...overrides,
  };
}

test('applyLogMessage upserts durable rows by id and sorts only by seq', () => {
  const slot = emptySlot();
  applyLogMessage(slot, message({ id: 'b', seq: 20, content: 'later' }));
  applyLogMessage(slot, message({ id: 'a', seq: 10, content: 'earlier' }));
  applyLogMessage(slot, message({ id: 'a', seq: 10, content: 'updated' }));

  assert.deepEqual(slot.serverMessages.map((entry) => [entry.id, entry.content]), [
    ['a', 'updated'],
    ['b', 'later'],
  ]);
});

test('durable user acknowledgement preserves local image data', () => {
  const slot = emptySlot();
  applyLogMessage(slot, message({
    id: 'user:11111111-1111-4111-8111-111111111111',
    kind: 'text',
    role: 'user',
    content: '',
    images: [{ data: 'data:image/png;base64,abc', name: 'image.png' }],
  }));
  applyLogMessage(slot, message({
    id: 'user:11111111-1111-4111-8111-111111111111',
    seq: 1,
    kind: 'text',
    role: 'user',
    content: '',
    images: [{ name: 'image.png', byteLength: 3 } as never],
  }));

  assert.equal(slot.serverMessages.length, 1);
  assert.equal(slot.serverMessages[0].images?.[0].data, 'data:image/png;base64,abc');
});

test('replaceWithFetched replaces durable rows and keeps the streaming tail', () => {
  const slot = emptySlot();
  slot.serverMessages = [message({ id: 'old', seq: 1 })];
  slot.realtimeMessages = [
    message({ id: '__streaming_session-1', kind: 'stream_delta', content: 'partial' }),
    message({
      id: 'user:22222222-2222-4222-8222-222222222222',
      kind: 'text',
      role: 'user',
      content: 'optimistic',
    }),
  ];

  replaceWithFetched(slot, [
    message({ id: 'new-b', seq: 20 }),
    message({ id: 'new-a', seq: 10 }),
  ]);

  assert.deepEqual(slot.serverMessages.map((entry) => entry.id), ['new-a', 'new-b']);
  assert.deepEqual(slot.merged.map((entry) => entry.id), [
    'new-a',
    'new-b',
    '__streaming_session-1',
    'user:22222222-2222-4222-8222-222222222222',
  ]);
});
