import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionMessagesDb,
} from '@/modules/database/index.js';
import {
  LoggingWriter,
  getLoggingWriterForSession,
} from '@/modules/websocket/services/logging-writer.service.js';
import type { AnyRecord } from '@/shared/types.js';

class FakeWriter {
  readonly sent: AnyRecord[] = [];
  ws: AnyRecord | null = { readyState: 1 };
  sessionId: string | null = null;
  userId: string | number | null = 7;
  readonly isWebSocketWriter = false;

  send(message: unknown): void {
    this.sent.push(message as AnyRecord);
  }

  updateWebSocket(ws: unknown): void {
    this.ws = ws as AnyRecord;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}

async function withDatabase(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'logging-writer-'));
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

test('new-session messages wait for session_created and release in queue order', async () => {
  await withDatabase(() => {
    const inner = new FakeWriter();
    const writer = new LoggingWriter(inner, { provider: 'codex' });
    writer.recordUserMessage({
      clientId: '11111111-1111-4111-8111-111111111111',
      content: 'hello',
      provider: 'codex',
    });
    writer.send({
      kind: 'task_notification',
      provider: 'codex',
      sessionId: 'temporary-id',
      status: 'warning',
      summary: 'warning',
    });
    writer.send({
      kind: 'session_created',
      provider: 'codex',
      sessionId: 'codex-session',
      newSessionId: 'codex-session',
    });

    assert.deepEqual(inner.sent.map((message) => message.kind), [
      'session_created',
      'text',
      'task_notification',
    ]);
    assert.deepEqual(
      sessionMessagesDb.list('codex-session').messages.map((message) => [message.kind, message.seq]),
      [['text', 1], ['task_notification', 2]],
    );
    assert.equal(getLoggingWriterForSession('codex-session'), writer);
    writer.finish();
  });
});

test('tool result folds into the original tool-use row and keeps its seq', async () => {
  await withDatabase(() => {
    const inner = new FakeWriter();
    const writer = new LoggingWriter(inner, {
      initialSessionId: 'session-tools',
      provider: 'codex',
    });
    writer.send({
      id: 'call_1',
      kind: 'tool_use',
      provider: 'codex',
      sessionId: 'session-tools',
      toolId: 'call_1',
      toolName: 'Bash',
      toolInput: { command: 'pwd' },
    });
    writer.send({
      id: 'call_1:result',
      kind: 'tool_result',
      provider: 'codex',
      sessionId: 'session-tools',
      toolId: 'call_1',
      content: '/workspace',
      isError: false,
    });

    assert.equal(inner.sent.length, 2);
    assert.equal(inner.sent[0].seq, 1);
    assert.equal(inner.sent[1].seq, 1);
    assert.equal(inner.sent[1].kind, 'tool_use');
    assert.equal(inner.sent[1].toolResult.content, '/workspace');
    assert.equal(sessionMessagesDb.list('session-tools').rows.length, 1);
    writer.finish();
  });
});

test('aborted complete produces one durable interruption marker', async () => {
  await withDatabase(() => {
    const inner = new FakeWriter();
    const writer = new LoggingWriter(inner, {
      initialSessionId: 'session-abort',
      provider: 'claude',
    });
    writer.send({
      kind: 'complete',
      provider: 'claude',
      sessionId: 'session-abort',
      aborted: true,
      success: true,
    });

    assert.deepEqual(inner.sent.map((message) => message.kind), ['text', 'complete']);
    assert.equal(inner.sent[0].isInterrupted, true);
    assert.match(String(inner.sent[0].id), /^session-abort:interrupted:/);
    assert.equal(sessionMessagesDb.list('session-abort').rows.length, 1);
  });
});

test('string runtime messages are parsed before persistence', async () => {
  await withDatabase(() => {
    const inner = new FakeWriter();
    const writer = new LoggingWriter(inner, {
      initialSessionId: 'session-string',
      provider: 'antigravity',
    });
    writer.send(JSON.stringify({
      id: 'error-1',
      kind: 'error',
      provider: 'antigravity',
      sessionId: 'session-string',
      content: 'failed',
    }));

    assert.equal(writer.isWebSocketWriter, true);
    assert.equal(inner.sent[0].seq, 1);
    assert.equal(inner.sent[0].kind, 'error');
    writer.finish();
  });
});

test('reconnect reuses the registered writer and replays buffered stream text', async () => {
  await withDatabase(() => {
    const inner = new FakeWriter();
    const writer = new LoggingWriter(inner, {
      initialSessionId: 'session-stream',
      provider: 'codex',
    });
    writer.send({
      kind: 'stream_delta',
      provider: 'codex',
      sessionId: 'session-stream',
      content: 'hello ',
    });
    writer.send({
      kind: 'stream_delta',
      provider: 'codex',
      sessionId: 'session-stream',
      content: 'world',
    });
    const nextWs = { readyState: 1 };
    const registered = getLoggingWriterForSession('session-stream');
    registered?.updateWebSocket(nextWs);
    registered?.replayAfterSeq(0);

    assert.equal(registered, writer);
    assert.deepEqual(inner.ws, nextWs);
    assert.equal(inner.sent.at(-1)?.kind, 'stream_delta');
    assert.equal(inner.sent.at(-1)?.content, 'hello world');
    writer.finish();
  });
});

test('oversized messages are truncated below the storage limit', async () => {
  await withDatabase(() => {
    const inner = new FakeWriter();
    const writer = new LoggingWriter(inner, {
      initialSessionId: 'session-large',
      provider: 'claude',
    });
    writer.send({
      id: 'large-error',
      kind: 'error',
      provider: 'claude',
      sessionId: 'session-large',
      content: 'x'.repeat(600 * 1024),
    });
    const stored = sessionMessagesDb.getById('session-large', 'large-error')?.payload;
    assert.equal(stored?.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(stored), 'utf8') <= 512 * 1024);
    writer.finish();
  });
});
