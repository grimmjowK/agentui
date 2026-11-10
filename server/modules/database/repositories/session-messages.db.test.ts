import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionMessagesDb } from '@/modules/database/repositories/session-messages.db.js';
import type { NormalizedMessage } from '@/shared/types.js';

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

async function withDatabase(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'session-messages-'));
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

test('session messages append monotonically and update by id without moving', async () => {
  await withDatabase(() => {
    const first = sessionMessagesDb.append('session-1', message({ id: 'a', content: 'first' }));
    const second = sessionMessagesDb.append('session-1', message({ id: 'b', content: 'second' }));
    const updated = sessionMessagesDb.upsertById('session-1', message({
      id: 'a',
      content: 'updated',
      toolResult: { content: 'done', isError: false },
    }));

    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(updated.message.seq, 1);
    assert.equal(updated.inserted, false);
    assert.deepEqual(
      sessionMessagesDb.list('session-1').rows.map((row) => [row.id, row.seq, row.payload.content]),
      [['a', 1, 'updated'], ['b', 2, 'second']],
    );
  });
});

test('user messages are idempotent and cannot overwrite another message kind', async () => {
  await withDatabase(() => {
    const userId = 'user:11111111-1111-4111-8111-111111111111';
    const inserted = sessionMessagesDb.insertUserIfAbsent(
      'session-1',
      message({ id: userId, role: 'user', content: 'hello' }),
      7,
    );
    const repeated = sessionMessagesDb.insertUserIfAbsent(
      'session-1',
      message({ id: userId, role: 'user', content: 'hello again' }),
      7,
    );

    assert.equal(inserted.status, 'inserted');
    assert.equal(repeated.status, 'existing');
    assert.equal(repeated.message?.content, 'hello');

    sessionMessagesDb.append('session-1', message({
      id: 'call_1',
      kind: 'tool_use',
      role: undefined,
      toolId: 'call_1',
      toolName: 'Bash',
    }));
    const conflict = sessionMessagesDb.insertUserIfAbsent(
      'session-1',
      message({ id: 'call_1', role: 'user', content: 'overwrite' }),
      7,
    );
    assert.equal(conflict.status, 'conflict');
    assert.equal(sessionMessagesDb.getById('session-1', 'call_1')?.payload.kind, 'tool_use');

    const crossSessionConflict = sessionMessagesDb.insertUserIfAbsent(
      'session-2',
      message({ id: userId, role: 'user', content: 'from another session' }),
      7,
    );
    assert.equal(crossSessionConflict.status, 'conflict');
  });
});

test('tool results fold into matching tool_use and preserve seq', async () => {
  await withDatabase(() => {
    const toolUse = sessionMessagesDb.append('session-1', message({
      id: 'call_1',
      kind: 'tool_use',
      role: undefined,
      toolId: 'call_1',
      toolName: 'Bash',
      toolInput: { command: 'pwd' },
    }));
    const folded = sessionMessagesDb.foldToolResult('session-1', message({
      id: 'call_1:result',
      kind: 'tool_result',
      content: '/workspace',
      toolId: 'call_1',
      isError: false,
    }));

    assert.equal(folded?.seq, toolUse.seq);
    assert.equal(folded?.toolResult?.content, '/workspace');
    const rows = sessionMessagesDb.listAll('session-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.kind, 'tool_use');
  });
});

test('beforeSeq pagination returns the preceding page in ascending order', async () => {
  await withDatabase(() => {
    for (let index = 1; index <= 5; index++) {
      sessionMessagesDb.append('session-1', message({ id: `m-${index}`, content: String(index) }));
    }
    const page = sessionMessagesDb.list('session-1', { beforeSeq: 5, limit: 2 });
    assert.deepEqual(page.messages.map((entry) => entry.id), ['m-3', 'm-4']);
    assert.equal(page.hasMore, true);
  });
});

test('insertBetween renumbers when floating-point space is exhausted', async () => {
  await withDatabase(() => {
    sessionMessagesDb.append('session-1', message({ id: 'left' }));
    sessionMessagesDb.append('session-1', message({ id: 'right' }));
    getConnection().prepare(
      'UPDATE session_messages SET seq = ? WHERE session_id = ? AND id = ?',
    ).run(1.0000000000000002, 'session-1', 'right');

    const inserted = sessionMessagesDb.insertBetween(
      'session-1',
      message({ id: 'middle' }),
      1,
      1.0000000000000002,
      'import',
    );
    assert.ok((inserted.seq ?? 0) > 1);
    assert.ok((inserted.seq ?? 0) < 2);
    assert.deepEqual(
      sessionMessagesDb.list('session-1').messages.map((entry) => entry.id),
      ['left', 'middle', 'right'],
    );
  });
});

test('insertBetween does not collide with rows already inside the gap', async () => {
  await withDatabase(() => {
    for (const id of ['a', 'b', 'c']) {
      sessionMessagesDb.append('session-1', message({ id }));
    }
    // 1 與 3 之間已有 seq=2，直接取中點會撞 UNIQUE(session_id, seq)
    sessionMessagesDb.insertBetween('session-1', message({ id: 'x' }), 1, 3, 'import');
    // 反向區間（歷史順序與日誌順序不一致）
    sessionMessagesDb.insertBetween('session-1', message({ id: 'y' }), 3, 1, 'import');
    // 只有右界，且右界之前已有資料
    sessionMessagesDb.insertBetween('session-1', message({ id: 'z' }), null, 3, 'import');
    assert.deepEqual(
      sessionMessagesDb.list('session-1').messages.map((entry) => entry.id),
      ['a', 'x', 'b', 'z', 'c', 'y'],
    );
  });
});

test('insertUserIfAbsent remains idempotent after updateProviderIds or when _logUserId was absent', async () => {
  await withDatabase(() => {
    const userId = 'user:44444444-4444-4444-8444-444444444444';
    const inserted = sessionMessagesDb.insertUserIfAbsent(
      'session-1',
      message({ id: userId, role: 'user', content: 'first' }),
      7,
    );
    assert.equal(inserted.status, 'inserted');

    // Simulate reconciler pairing updating providerIds on the user row
    sessionMessagesDb.updateProviderIds('session-1', userId, ['provider-u1']);

    // Retry from the same user must return 'existing', not 'conflict'
    const retryAfterPairing = sessionMessagesDb.insertUserIfAbsent(
      'session-1',
      message({ id: userId, role: 'user', content: 'first' }),
      7,
    );
    assert.equal(retryAfterPairing.status, 'existing');

    // Retry from a different user must still be rejected as 'conflict'
    const conflictOtherUser = sessionMessagesDb.insertUserIfAbsent(
      'session-1',
      message({ id: userId, role: 'user', content: 'hijack' }),
      99,
    );
    assert.equal(conflictOtherUser.status, 'conflict');

    // Imported user message (no _logUserId) in same session should not conflict when userId is passed
    const importedUserId = 'user:55555555-5555-4555-8555-555555555555';
    sessionMessagesDb.append(
      'session-1',
      message({ id: importedUserId, role: 'user', content: 'imported' }),
      'import',
    );
    const retryImported = sessionMessagesDb.insertUserIfAbsent(
      'session-1',
      message({ id: importedUserId, role: 'user', content: 'imported' }),
      7,
    );
    assert.equal(retryImported.status, 'existing');
  });
});

