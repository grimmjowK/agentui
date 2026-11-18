import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, multiAgentsDb } from '@/modules/database/index.js';
import { WorkflowRunner } from '@/modules/multi-agent/services/workflow-runner.js';

import type { WorkflowDef } from '../../../../shared/multiAgent.js';

import { createMockRuntime, say, tick, type Script } from './mock-runtime.js';

async function withDb(run: () => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'wf-runner-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try { await run(); } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const node = (id: string, dependsOn: string[] = []) => ({ id, title: id.toUpperCase(), instruction: `do ${id}`, provider: 'claude' as const, model: 'sonnet', dependsOn });

function setup(def: WorkflowDef, script: Script) {
  const mock = createMockRuntime(script);
  const events: unknown[] = [];
  const runner = new WorkflowRunner({ resolveRuntime: () => mock.runtime, publish: (_u, e) => events.push(e) });
  const created = multiAgentsDb.create(1, { kind: 'workflow', name: 'wf', workspacePath: '/tmp' });
  const agent = { ...multiAgentsDb.setDefinition(1, created.id, def)!, userId: 1 };
  return { mock, runner, agent, events };
}

test('依序執行並把上游輸出帶入下游', async () => {
  await withDb(async () => {
    const { mock, runner, agent } = setup({ nodes: [node('a'), node('b', ['a'])] },
      async (ctx) => say(ctx.prompt.includes('do a') ? 'A-RESULT' : 'B-RESULT')(ctx));
    const started = runner.start(agent)!;
    await started.done;
    const run = multiAgentsDb.getRun(agent.id, started.run.id)!;
    assert.equal(run.status, 'succeeded');
    assert.equal(run.nodeStates.a.output, 'A-RESULT');
    assert.equal(run.nodeStates.b.progress, 100);
    assert.equal(mock.calls.length, 2);
    assert.match(mock.calls[1].prompt, /A-RESULT/);
    assert.equal(mock.calls[0].options.permissionMode, 'default');
  });
});

test('並行上限 3 且重複開始被拒', async () => {
  await withDb(async () => {
    const { mock, runner, agent } = setup({ nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => node(id)) }, say('ok', 20));
    const started = runner.start(agent)!;
    assert.equal(runner.start(agent), null);
    await started.done;
    assert.equal(mock.maxConcurrent, 3);
  });
});

test('失敗節點的下游被略過', async () => {
  await withDb(async () => {
    const { runner, agent } = setup({ nodes: [node('a'), node('b', ['a']), node('c')] }, async (ctx) => {
      if (ctx.prompt.includes('do a')) ctx.writer.send({ kind: 'error', content: 'boom', sessionId: ctx.sessionId });
      else await say('ok')(ctx);
    });
    const started = runner.start(agent)!;
    await started.done;
    const run = multiAgentsDb.getRun(agent.id, started.run.id)!;
    assert.equal(run.status, 'failed');
    assert.equal(run.nodeStates.a.state, 'failed');
    assert.equal(run.nodeStates.a.error, 'boom');
    assert.equal(run.nodeStates.b.state, 'skipped');
    assert.equal(run.nodeStates.c.state, 'succeeded');
  });
});

test('停止：執行中節點失敗、未開始節點略過、不啟動下游', async () => {
  await withDb(async () => {
    const { mock, runner, agent } = setup({ nodes: [node('a'), node('b', ['a'])] }, say('slow', 2000));
    const started = runner.start(agent)!;
    await tick(20);
    assert.equal(await runner.stop(started.run.id), true);
    await started.done;
    const run = multiAgentsDb.getRun(agent.id, started.run.id)!;
    assert.equal(run.status, 'stopped');
    assert.equal(run.nodeStates.a.state, 'failed');
    assert.equal(run.nodeStates.a.error, 'stopped');
    assert.equal(run.nodeStates.b.state, 'skipped');
    assert.equal(mock.calls.length, 1);
    assert.equal(await runner.stop(started.run.id), false);
  });
});

test('審批中節點顯示 waiting_approval', async () => {
  await withDb(async () => {
    const seen: string[] = [];
    const { runner, agent, events } = setup({ nodes: [node('a')] }, async (ctx) => {
      ctx.writer.send({ kind: 'permission_request', requestId: 'r1', toolName: 'Write', sessionId: ctx.sessionId });
      await tick(10);
      await say('done')(ctx);
    });
    await runner.start(agent)!.done;
    for (const e of events as { node?: { state: string } }[]) if (e.node) seen.push(e.node.state);
    assert.ok(seen.includes('waiting_approval'));
    assert.equal(seen.at(-1), 'succeeded');
  });
});

test('人工確認節點：暫停直到核准，備註與上游輸出傳給下游；駁回則下游略過', async () => {
  await withDb(async () => {
    const gate = { id: 'gate', title: '確認', instruction: '請確認方案', type: 'approval' as const, dependsOn: ['a'] };
    const def = { nodes: [node('a'), gate, node('b', ['gate'])] } as WorkflowDef;
    const { mock, runner, agent } = setup(def, async (ctx) => say(ctx.prompt.includes('do a') ? 'PLAN' : 'APPLIED')(ctx));
    const started = runner.start(agent)!;
    while (multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.gate.state !== 'waiting_confirmation') await tick(5);
    assert.equal(mock.calls.length, 1, '確認前不執行下游');
    assert.equal(runner.confirm(started.run.id, 'b', true), false);
    assert.equal(runner.confirm(started.run.id, 'gate', true, '只做 18350'), true);
    await started.done;
    const run = multiAgentsDb.getRun(agent.id, started.run.id)!;
    assert.equal(run.status, 'succeeded');
    assert.match(mock.calls[1].prompt, /PLAN[\s\S]*只做 18350/);

    const second = runner.start(agent)!;
    while (multiAgentsDb.getRun(agent.id, second.run.id)!.nodeStates.gate.state !== 'waiting_confirmation') await tick(5);
    runner.confirm(second.run.id, 'gate', false);
    await second.done;
    const rejected = multiAgentsDb.getRun(agent.id, second.run.id)!;
    assert.equal(rejected.nodeStates.gate.error, 'rejected');
    assert.equal(rejected.nodeStates.b.state, 'skipped');
  });
});

test('停止時等待中的人工確認節點被駁回', async () => {
  await withDb(async () => {
    const def = { nodes: [{ id: 'gate', title: 'g', instruction: 'x', type: 'approval' as const, dependsOn: [] }] } as WorkflowDef;
    const { runner, agent } = setup(def, say('x'));
    const started = runner.start(agent)!;
    await tick(10);
    await runner.stop(started.run.id);
    await started.done;
    assert.equal(multiAgentsDb.getRun(agent.id, started.run.id)!.status, 'stopped');
  });
});
