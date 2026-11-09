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
  reconcileSessionMessageLog,
} from '@/modules/providers/services/session-message-reconciler.service.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';

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
  const directory = await mkdtemp(path.join(tmpdir(), 'reconcile-'));
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

function append(sessionId: string, entry: NormalizedMessage, provider: LLMProvider = 'codex') {
  return sessionMessagesDb.append(sessionId, {
    ...entry,
    sessionId,
    provider,
  }, 'live');
}

test('reconciliation supplements matching rows and imports a terminal tail in order', async () => {
  await withDatabase(() => {
    append('session-1', message({
      id: 'tool-1',
      kind: 'tool_use',
      role: undefined,
      toolId: 'tool-1',
      toolName: 'Edit',
      toolInput: { file_path: 'a.ts', old_string: '', new_string: '' },
    }));
    const history = [
      message({
        id: 'tool-1',
        providerIds: ['tool-1'],
        kind: 'tool_use',
        role: undefined,
        toolId: 'tool-1',
        toolName: 'Edit',
        toolInput: { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
        toolResult: { content: 'updated', isError: false },
      }),
      message({ id: 'user-2', role: 'user', content: 'terminal turn' }),
      message({ id: 'assistant-2', providerIds: ['assistant-2'], content: 'done' }),
    ];

    const result = reconcileSessionMessageLog({
      sessionId: 'session-1',
      provider: 'codex',
      history,
      active: false,
    });

    assert.deepEqual(result.map((entry) => entry.id), ['tool-1', 'user-2', 'assistant-2']);
    assert.equal((result[0].toolInput as Record<string, unknown>)?.old_string, 'a');
    assert.equal(result[0].toolResult?.content, 'updated');

    const second = reconcileSessionMessageLog({
      sessionId: 'session-1',
      provider: 'codex',
      history,
      active: false,
    });
    assert.deepEqual(second.map((entry) => entry.id), ['tool-1', 'user-2', 'assistant-2']);
  });
});

test('reconciliation inserts provider-internal user messages between anchors', async () => {
  await withDatabase(() => {
    append('session-1', message({ id: 'a1', providerIds: ['a1'] }));
    append('session-1', message({ id: 'a2', providerIds: ['a2'], content: 'second' }));
    const history = [
      message({ id: 'a1', content: 'hello' }),
      message({
        id: 'instructions',
        role: 'user',
        content: '# AGENTS.md instructions for /workspace',
      }),
      message({ id: 'a2', content: 'second' }),
    ];

    const result = reconcileSessionMessageLog({
      sessionId: 'session-1',
      provider: 'codex',
      history,
      active: false,
    });
    assert.deepEqual(result.map((entry) => entry.id), ['a1', 'instructions', 'a2']);
    assert.ok((result[1].seq ?? 0) > (result[0].seq ?? 0));
    assert.ok((result[1].seq ?? 0) < (result[2].seq ?? 0));
  });
});

test('user messages pair by anchor segment without text comparison', async () => {
  await withDatabase(() => {
    append('session-1', message({
      id: 'user:11111111-1111-4111-8111-111111111111',
      role: 'user',
      content: '',
      images: [{ name: 'image.png', byteLength: 10 }],
    }));
    append('session-1', message({ id: 'a1', providerIds: ['a1'], content: 'reply' }));
    const history = [
      message({ id: 'provider-user', role: 'user', content: '', providerIds: ['provider-user'] }),
      message({ id: 'a1', content: 'reply' }),
    ];

    const result = reconcileSessionMessageLog({
      sessionId: 'session-1',
      provider: 'codex',
      history,
      active: false,
    });
    assert.deepEqual(result.map((entry) => entry.id), [
      'user:11111111-1111-4111-8111-111111111111',
      'a1',
    ]);
    assert.deepEqual(
      sessionMessagesDb.getById('session-1', result[0].id)?.providerIds,
      ['provider-user'],
    );
  });
});

test('active sessions are supplemented but never import unmatched history', async () => {
  await withDatabase(() => {
    append('session-1', message({ id: 'a1', providerIds: ['a1'], content: 'live' }));
    const result = reconcileSessionMessageLog({
      sessionId: 'session-1',
      provider: 'codex',
      history: [
        message({ id: 'a1', content: 'full history' }),
        message({ id: 'a2', content: 'not emitted live yet' }),
      ],
      active: true,
    });
    assert.deepEqual(result.map((entry) => entry.id), ['a1']);
    assert.equal(result[0].content, 'full history');
  });
});

test('a truncated stable anchor disappearing from non-empty history rebuilds the log', async () => {
  await withDatabase(() => {
    append('session-1', message({ id: 'a1', providerIds: ['a1'] }));
    append('session-1', message({ id: 'a2', providerIds: ['a2'], content: 'removed by rewind' }));
    const result = reconcileSessionMessageLog({
      sessionId: 'session-1',
      provider: 'codex',
      history: [message({ id: 'a1', content: 'hello' })],
      active: false,
    });
    assert.deepEqual(result.map((entry) => entry.id), ['a1']);
  });
});

test('providers without an id contract do not reconcile a non-empty log', async () => {
  await withDatabase(() => {
    append('session-1', message({ id: 'a1', providerIds: ['a1'] }), 'cursor');
    const result = reconcileSessionMessageLog({
      sessionId: 'session-1',
      provider: 'cursor',
      history: [message({ id: 'a2', provider: 'cursor', content: 'history only' })],
      active: false,
    });
    assert.deepEqual(result.map((entry) => entry.id), ['a1']);
  });
});

test('an empty log imports provider history once without standalone tool results', async () => {
  await withDatabase(() => {
    const history = [
      message({ id: 'u1', role: 'user', content: 'hello' }),
      message({
        id: 'tool-1',
        kind: 'tool_use',
        role: undefined,
        toolId: 'tool-1',
        toolName: 'Bash',
        toolResult: { content: 'ok', isError: false },
      }),
      message({
        id: 'tool-result',
        kind: 'tool_result',
        content: 'ok',
        toolId: 'tool-1',
      }),
      message({ id: 'a1', content: 'done' }),
    ];
    const first = reconcileSessionMessageLog({
      sessionId: 'session-1',
      provider: 'codex',
      history,
      active: false,
    });
    const repeated = Array.from({ length: 9 }, () => reconcileSessionMessageLog({
      sessionId: 'session-1',
      provider: 'codex',
      history,
      active: false,
    }));
    assert.deepEqual(first.map((entry) => entry.id), ['u1', 'tool-1', 'a1']);
    for (const result of repeated) {
      assert.deepEqual(result.map((entry) => entry.id), ['u1', 'tool-1', 'a1']);
    }
  });
});

test('mismatched user counts leave that segment unchanged', async () => {
  await withDatabase(() => {
    append('session-1', message({
      id: 'user:22222222-2222-4222-8222-222222222222',
      role: 'user',
      content: 'live only',
    }));
    append('session-1', message({ id: 'a1', providerIds: ['a1'], content: 'reply' }));
    const result = reconcileSessionMessageLog({
      sessionId: 'session-1',
      provider: 'codex',
      history: [
        message({ id: 'h-user-1', role: 'user', content: 'one' }),
        message({ id: 'h-user-2', role: 'user', content: 'two' }),
        message({ id: 'a1', content: 'reply' }),
      ],
      active: false,
    });
    assert.deepEqual(result.map((entry) => entry.id), [
      'user:22222222-2222-4222-8222-222222222222',
      'a1',
    ]);
  });
});

test('interruption markers pair within their anchor segment and do not shift later users', async () => {
  await withDatabase(() => {
    append('session-1', message({ id: 'a1', providerIds: ['a1'], content: 'first' }));
    append('session-1', message({
      id: 'session-1:interrupted:run-1',
      role: 'user',
      content: '<turn_aborted>',
      isInterrupted: true,
    }));
    append('session-1', message({
      id: 'user:33333333-3333-4333-8333-333333333333',
      role: 'user',
      content: 'next turn',
    }));
    append('session-1', message({ id: 'a2', providerIds: ['a2'], content: 'second' }));

    const result = reconcileSessionMessageLog({
      sessionId: 'session-1',
      provider: 'codex',
      history: [
        message({ id: 'a1', content: 'first' }),
        message({
          id: 'history-interrupted',
          role: 'user',
          content: '<turn_aborted>',
          isInterrupted: true,
        }),
        message({ id: 'history-user-next', role: 'user', content: 'next turn' }),
        message({ id: 'a2', content: 'second' }),
      ],
      active: false,
    });
    assert.deepEqual(result.map((entry) => entry.id), [
      'a1',
      'session-1:interrupted:run-1',
      'user:33333333-3333-4333-8333-333333333333',
      'a2',
    ]);
  });
});

test('imported session log detects /rewind divergence when a previously imported stable anchor disappears', async () => {
  await withDatabase(() => {
    // Initial full import of 2 turns
    const initialHistory = [
      message({ id: 'u1', role: 'user', content: 'turn 1' }),
      message({ id: 'a1', providerIds: ['a1'], content: 'reply 1' }),
      message({ id: 'u2', role: 'user', content: 'turn 2' }),
      message({ id: 'a2', providerIds: ['a2'], content: 'reply 2' }),
    ];
    const imported = reconcileSessionMessageLog({
      sessionId: 'session-rewind-import',
      provider: 'claude',
      history: initialHistory,
      active: false,
    });
    assert.deepEqual(imported.map((entry) => entry.id), ['u1', 'a1', 'u2', 'a2']);

    // Now user runs /rewind in CLI, truncating turn 2 from history
    const rewoundHistory = [
      message({ id: 'u1', role: 'user', content: 'turn 1' }),
      message({ id: 'a1', providerIds: ['a1'], content: 'reply 1' }),
    ];
    const afterRewind = reconcileSessionMessageLog({
      sessionId: 'session-rewind-import',
      provider: 'claude',
      history: rewoundHistory,
      active: false,
    });
    assert.deepEqual(afterRewind.map((entry) => entry.id), ['u1', 'a1']);
  });
});

test('Claude subagent live messages (parentToolUseId) do not falsely trigger divergence rebuild', async () => {
  await withDatabase(() => {
    append('session-subagent', message({
      id: 'user:11111111-1111-4111-8111-111111111111',
      role: 'user',
      content: 'run subagent',
    }), 'claude');
    append('session-subagent', message({
      id: 'task-tool-1',
      providerIds: ['task-tool-1'],
      kind: 'tool_use',
      role: undefined,
      toolId: 'task-tool-1',
      toolName: 'Task',
    }), 'claude');
    // Live subagent tool_use emitted with parentToolUseId during streaming
    append('session-subagent', message({
      id: 'subagent-tool-1',
      providerIds: ['subagent-tool-1'],
      kind: 'tool_use',
      role: undefined,
      toolId: 'subagent-tool-1',
      toolName: 'Bash',
      parentToolUseId: 'task-tool-1',
    }), 'claude');
    // Live-only warning that must survive reconciliation if no real divergence happened
    append('session-subagent', message({
      id: 'warn-live-1',
      kind: 'task_notification',
      role: undefined,
      status: 'warning',
      summary: 'concurrent shell warning',
    }), 'claude');
    append('session-subagent', message({
      id: 'assistant-final',
      providerIds: ['assistant-final'],
      content: 'all done',
    }), 'claude');

    // In Claude history JSONL, subagent tools are nested in subagentTools on the parent Task tool_use, not top-level
    const history = [
      message({ id: 'u-hist-1', role: 'user', content: 'run subagent', provider: 'claude' }),
      message({
        id: 'task-tool-1',
        providerIds: ['task-tool-1'],
        kind: 'tool_use',
        role: undefined,
        toolId: 'task-tool-1',
        toolName: 'Task',
        provider: 'claude',
        subagentTools: [
          {
            id: 'subagent-tool-1',
            toolId: 'subagent-tool-1',
            toolName: 'Bash',
          },
        ],
      }),
      message({ id: 'assistant-final', providerIds: ['assistant-final'], content: 'all done', provider: 'claude' }),
    ];

    const result = reconcileSessionMessageLog({
      sessionId: 'session-subagent',
      provider: 'claude',
      history,
      active: false,
    });

    // Must NOT wipe the journal; warn-live-1 and user:clientId must be preserved!
    assert.ok(result.some((entry) => entry.id === 'warn-live-1'), 'live warning must not be wiped');
    assert.ok(result.some((entry) => entry.id === 'user:11111111-1111-4111-8111-111111111111'), 'user clientId must not be wiped');
  });
});

