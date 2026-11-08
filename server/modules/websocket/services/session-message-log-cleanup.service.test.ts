import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionMessagesDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { LoggingWriter } from '@/modules/websocket/services/logging-writer.service.js';
import { runSessionMessageLogCleanup } from '@/modules/websocket/services/session-message-log-cleanup.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

function message(sessionId: string, bytes: number): NormalizedMessage {
  return {
    id: 'message-1',
    sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: 'x'.repeat(bytes),
  };
}

async function withDatabase(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'session-cleanup-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function setUpdatedAt(sessionId: string, updatedAt: number): void {
  getConnection().prepare(
    'UPDATE session_messages SET updated_at = ? WHERE session_id = ?',
  ).run(updatedAt, sessionId);
}

test('cleanup removes expired sessions but keeps starred and active logs', async () => {
  await withDatabase(() => {
    for (const sessionId of ['old', 'starred', 'active', 'recent']) {
      sessionsDb.createSession(sessionId, 'claude', `/workspace/${sessionId}`);
      sessionMessagesDb.append(sessionId, message(sessionId, 10));
    }
    sessionsDb.updateSessionIsStarred('starred', true);
    const now = Date.UTC(2026, 5, 1);
    setUpdatedAt('old', now - 120 * 24 * 60 * 60 * 1000);
    setUpdatedAt('starred', now - 200 * 24 * 60 * 60 * 1000);
    setUpdatedAt('active', now - 200 * 24 * 60 * 60 * 1000);
    setUpdatedAt('recent', now - 2 * 24 * 60 * 60 * 1000);

    const writer = new LoggingWriter({
      userId: 7,
      send() {},
      setSessionId() {},
      getSessionId() { return 'active'; },
    }, { initialSessionId: 'active', provider: 'claude' });

    const result = runSessionMessageLogCleanup({
      now,
      retentionDays: 90,
      maxBytes: 0,
    });
    assert.deepEqual(result.deletedSessionIds, ['old']);
    assert.equal(sessionMessagesDb.list('old').total, 0);
    assert.equal(sessionMessagesDb.list('starred').total, 1);
    assert.equal(sessionMessagesDb.list('active').total, 1);
    assert.equal(sessionMessagesDb.list('recent').total, 1);
    writer.finish();
  });
});

test('size cleanup deletes oldest unprotected sessions until below 90 percent', async () => {
  await withDatabase(() => {
    const now = Date.UTC(2026, 5, 1);
    for (const [index, sessionId] of ['a', 'b', 'c'].entries()) {
      sessionsDb.createSession(sessionId, 'claude', `/workspace/${sessionId}`);
      sessionMessagesDb.append(sessionId, message(sessionId, 200));
      setUpdatedAt(sessionId, now - (3 - index) * 1000);
    }

    const result = runSessionMessageLogCleanup({
      now,
      retentionDays: 0,
      maxBytes: 350,
    });
    assert.deepEqual(result.deletedSessionIds, ['a', 'b', 'c']);
    assert.ok(result.remainingBytes <= 315);
  });
});
