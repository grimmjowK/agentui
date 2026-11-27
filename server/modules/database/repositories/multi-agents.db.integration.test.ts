import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { multiAgentsDb } from '@/modules/database/repositories/multi-agents.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'multi-agents-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const workflow = { nodes: [{ id: 'a', title: 'A', instruction: 'x', provider: 'claude' as const, model: 'sonnet', dependsOn: [] }] };

test('建立、使用者隔離、更新定義遞增版本、列表依更新時間排序', async () => {
  await withIsolatedDatabase(async () => {
    const first = multiAgentsDb.create(1, { kind: 'workflow', name: 'first', workspacePath: '/tmp/a' });
    await new Promise((r) => setTimeout(r, 5));
    const second = multiAgentsDb.create(1, { kind: 'chatroom', name: 'second', workspacePath: '/tmp/b' });
    assert.equal(first.definition, null);
    assert.equal(multiAgentsDb.get(2, first.id), null, '其他使用者不可讀取');

    await new Promise((r) => setTimeout(r, 5));
    const updated = multiAgentsDb.setDefinition(1, first.id, workflow);
    assert.equal(updated?.definitionVersion, 1);
    assert.deepEqual(updated?.definition, workflow);
    assert.deepEqual(multiAgentsDb.list(1).map((a) => a.id), [first.id, second.id]);
    assert.deepEqual(multiAgentsDb.list(2), []);
  });
});

test('run 保存快照、同時最多允許五個 running run', async () => {
  await withIsolatedDatabase(() => {
    const agent = multiAgentsDb.create(1, { kind: 'workflow', name: 'wf', workspacePath: '/tmp' });
    const withDef = multiAgentsDb.setDefinition(1, agent.id, workflow)!;
    const run = multiAgentsDb.createRun(withDef, { a: { state: 'pending', progress: 0 } });
    assert.ok(run);
    for (let i = 1; i < 5; i++) assert.ok(multiAgentsDb.createRun(withDef, {}));
    assert.equal(multiAgentsDb.createRun(withDef, {}), null);

    multiAgentsDb.setDefinition(1, agent.id, { nodes: [{ ...workflow.nodes[0], id: 'b' }] });
    assert.equal(multiAgentsDb.getRun(agent.id, run!.id)?.definition.nodes[0].id, 'a', '舊 run 讀快照');

    multiAgentsDb.updateRun(run!.id, { status: 'succeeded', finished: true });
    assert.ok(multiAgentsDb.createRun(withDef, {}));
  });
});

test('訊息 seq 遞增、排隊訊息、刪除級聯', async () => {
  await withIsolatedDatabase(() => {
    const agent = multiAgentsDb.create(1, { kind: 'chatroom', name: 'room', workspacePath: '/tmp' });
    const base = { multiAgentId: agent.id, turnId: null, authorKind: 'user' as const, memberId: null, author: null, finishReason: null };
    const m1 = multiAgentsDb.appendMessage({ ...base, content: 'hi', status: 'done' });
    const m2 = multiAgentsDb.appendMessage({ ...base, content: 'queued', status: 'queued' });
    assert.deepEqual([m1.seq, m2.seq], [1, 2]);
    assert.equal(multiAgentsDb.nextQueuedMessage(agent.id)?.id, m2.id);
    assert.deepEqual(multiAgentsDb.listMessagesAfter(agent.id, 0).map((m) => m.id), [m1.id]);
    assert.equal(multiAgentsDb.deleteQueuedMessage(agent.id, m1.id), false, '非排隊訊息不可刪');
    assert.equal(multiAgentsDb.deleteQueuedMessage(agent.id, m2.id), true);

    multiAgentsDb.createTurn(agent.id, m1.id, { members: [], rules: {} as never });
    assert.ok(multiAgentsDb.getActiveTurn(agent.id));
    assert.equal(multiAgentsDb.delete(2, agent.id), false);
    assert.equal(multiAgentsDb.delete(1, agent.id), true);
    assert.deepEqual(multiAgentsDb.listMessages(agent.id), []);
    assert.equal(multiAgentsDb.getActiveTurn(agent.id), null);
  });
});

test('markInterrupted 標記執行中 run 與回合', async () => {
  await withIsolatedDatabase(() => {
    const agent = multiAgentsDb.setDefinition(1, multiAgentsDb.create(1, { kind: 'workflow', name: 'wf', workspacePath: '/tmp' }).id, workflow)!;
    const run = multiAgentsDb.createRun(agent, { a: { state: 'running', progress: 50 } })!;
    multiAgentsDb.markInterrupted();
    const after = multiAgentsDb.getRun(agent.id, run.id)!;
    assert.equal(after.status, 'interrupted');
    assert.equal(after.nodeStates.a.state, 'failed');
  });
});
