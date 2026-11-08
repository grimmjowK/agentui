import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyLogMessage,
  clearLogStreaming,
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

test('user steer message with seq does not clear assistant streaming placeholder', () => {
  const slot = emptySlot();
  slot.realtimeMessages = [
    message({ id: '__streaming_session-1', sessionId: 'session-1', kind: 'stream_delta', content: 'assistant typing...' }),
  ];

  applyLogMessage(slot, message({
    id: 'user:33333333-3333-4333-8333-333333333333',
    sessionId: 'session-1',
    seq: 5,
    kind: 'text',
    role: 'user',
    content: 'steer instruction',
  }));

  assert.equal(slot.realtimeMessages.some((entry) => entry.id === '__streaming_session-1'), true);
  assert.deepEqual(slot.merged.map((entry) => entry.id), [
    'user:33333333-3333-4333-8333-333333333333',
    '__streaming_session-1',
  ]);
});

test('late optimistic user message without seq merges local image data into already-acked serverMessage', () => {
  const slot = emptySlot();
  const userId = 'user:44444444-4444-4444-8444-444444444444';
  // Server ack arrives first (e.g. new session flush immediately after session_created) without base64 data
  applyLogMessage(slot, message({
    id: userId,
    seq: 1,
    kind: 'text',
    role: 'user',
    content: '',
    images: [{ name: 'photo.png', mimeType: 'image/png', byteLength: 3 } as never],
  }));

  // React effect flushes pendingUserMessage afterwards (no seq, has base64 data)
  applyLogMessage(slot, message({
    id: userId,
    kind: 'text',
    role: 'user',
    content: '',
    images: [{ name: 'photo.png', data: 'data:image/png;base64,xyz' }],
  }));

  assert.equal(slot.merged.length, 1);
  assert.equal(slot.merged[0].id, userId);
  assert.equal(slot.merged[0].seq, 1);
  assert.equal(slot.merged[0].images?.[0]?.data, 'data:image/png;base64,xyz');
});

test('clearLogStreaming removes residual streaming placeholder on complete or error', () => {
  const slot = emptySlot();
  slot.realtimeMessages = [
    message({ id: '__streaming_session-1', sessionId: 'session-1', kind: 'stream_delta', content: 'aborted stream' }),
    message({ id: 'user:55555555-5555-4555-8555-555555555555', sessionId: 'session-1', kind: 'text', role: 'user', content: 'next' }),
  ];
  slot.merged = [...slot.realtimeMessages];

  clearLogStreaming(slot, 'session-1');

  assert.deepEqual(slot.realtimeMessages.map((entry) => entry.id), [
    'user:55555555-5555-4555-8555-555555555555',
  ]);
  assert.deepEqual(slot.merged.map((entry) => entry.id), [
    'user:55555555-5555-4555-8555-555555555555',
  ]);
});

