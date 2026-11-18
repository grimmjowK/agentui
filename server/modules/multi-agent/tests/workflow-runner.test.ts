import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, multiAgentsDb, sessionMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { workflowSessions } from '@/shared/workflow-session-registry.js';
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

test('啟動時輸入只附給入口節點，並保存在 run', async () => {
  await withDb(async () => {
    const { mock, runner, agent } = setup({ nodes: [node('a'), node('b', ['a'])] }, say('ok'));
    const started = runner.start(agent, '只處理工單 18350')!;
    await started.done;
    assert.match(mock.calls[0].prompt, /本次執行的輸入\n只處理工單 18350/);
    assert.doesNotMatch(mock.calls[1].prompt, /本次執行的輸入/);
    assert.equal(multiAgentsDb.getRun(agent.id, started.run.id)!.startInput, '只處理工單 18350');
    assert.equal(mock.calls[0].options.cwd, '/tmp');
  });
});

// ---------------- 節點會話（node-live-session-and-agy-acp） ----------------

const waitFor = async (check: () => boolean, ms = 2000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timeout');
    await tick(2);
  }
};

/** 模擬聊天頁按停止：標記使用者中斷並呼叫 runtime.abort */
async function interruptFromChat(mock: ReturnType<typeof createMockRuntime>, sessionId: string) {
  workflowSessions.get(sessionId)!.markUserInterrupted();
  await mock.runtime.abort(sessionId, { send() {} } as never);
}

test('節點事件寫入會話紀錄、登記 workflow_sessions，且不出現在專案會話列表', async () => {
  await withDb(async () => {
    const { runner, agent } = setup({ nodes: [node('a')] }, say('A-OUT'));
    sessionsDb.createSession('s1', 'claude', '/tmp', 'node');
    sessionsDb.createSession('plain', 'claude', '/tmp', 'plain');
    const started = runner.start(agent)!;
    await started.done;
    const rows = sessionMessagesDb.list('s1', { afterSeq: null, limit: null }).messages;
    assert.deepEqual(rows.map((m) => [m.role, m.content]), [['user', rows[0].content], ['assistant', 'A-OUT']]);
    assert.match(String(rows[0].content), /do a/);
    assert.deepEqual(multiAgentsDb.getWorkflowSession('s1'), { multiAgentId: agent.id, runId: started.run.id, nodeId: 'a', userId: 1 });
    assert.equal(workflowSessions.get('s1'), null, '結束後移出執行中登記');
    const listed = sessionsDb.getSessionsByProjectPath('/tmp').map((r) => r.session_id);
    assert.deepEqual(listed, ['plain']);
    assert.equal(sessionsDb.countSessionsByProjectPath('/tmp'), 1);
    assert.deepEqual(sessionsDb.getAllSessions().map((r) => r.session_id), ['plain']);
    assert.ok(sessionsDb.getSessionById('s1'), '按 id 仍可載入');
    multiAgentsDb.delete(1, agent.id);
    assert.equal(multiAgentsDb.getWorkflowSession('s1'), null, '刪除多 Agent 時級聯刪除');
  });
});

test('聊天頁中斷 → waiting_input → 新指示續接 → 成功，輸出累加且下游收到', async () => {
  await withDb(async () => {
    const { mock, runner, agent } = setup({ nodes: [node('a'), node('b', ['a'])] }, async (ctx) => {
      if (ctx.prompt.includes('do a')) await say('PART1', 5000)(ctx);
      else if (ctx.prompt === 'fix it') await say('PART2')(ctx);
      else await say('B-OUT')(ctx);
    });
    const started = runner.start(agent)!;
    await waitFor(() => Boolean(workflowSessions.get('s1')));
    assert.equal(workflowSessions.get('s1')!.resume('too early', 'c0'), false, '執行中不能續接');
    await interruptFromChat(mock, 's1');
    await waitFor(() => workflowSessions.get('s1')?.state() === 'waiting_input');
    assert.equal(multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.a.state, 'waiting_input');
    assert.equal(workflowSessions.get('s1')!.resume('fix it', 'c1'), true);
    await started.done;
    const run = multiAgentsDb.getRun(agent.id, started.run.id)!;
    assert.equal(run.status, 'succeeded');
    assert.equal(run.nodeStates.a.output, 'PART1\n\nPART2');
    assert.equal(mock.calls[1].options.sessionId, 's1');
    assert.equal(mock.calls[1].options.resume, true);
    assert.match(mock.calls[2].prompt, /PART1\n\nPART2/);
    const users = sessionMessagesDb.list('s1', { afterSeq: null, limit: null }).messages.filter((m) => m.role === 'user');
    assert.ok(users.some((m) => m.content === 'fix it'), '新指示記入節點會話');
  });
});

test('waiting_input：以目前輸出完成、標記失敗、工作流停止', async () => {
  for (const action of ['complete', 'fail', 'stop'] as const) {
    await withDb(async () => {
      const { mock, runner, agent } = setup({ nodes: [node('a')] }, say('PART1', 5000));
      const started = runner.start(agent)!;
      await waitFor(() => Boolean(workflowSessions.get('s1')));
      await interruptFromChat(mock, 's1');
      await waitFor(() => workflowSessions.get('s1')?.state() === 'waiting_input');
      if (action === 'stop') await runner.stop(started.run.id);
      else assert.equal(runner.finishWaitingInput(started.run.id, 'a', action), true);
      await started.done;
      const a = multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.a;
      if (action === 'complete') {
        assert.equal(a.state, 'succeeded');
        assert.equal(a.output, 'PART1');
      } else {
        assert.equal(a.state, 'failed');
        assert.equal(a.error, action === 'stop' ? 'stopped' : 'rejected');
      }
      assert.equal(runner.finishWaitingInput(started.run.id, 'a', 'complete'), false);
    });
  }
});
