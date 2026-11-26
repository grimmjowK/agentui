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

test('單一 run 節點並行上限 3；同一工作流最多允許 5 個並行 run', async () => {
  await withDb(async () => {
    const { mock, runner, agent } = setup({ nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => node(id)) }, say('ok', 20));
    const started = runner.start(agent)!;
    await started.done;
    assert.equal(mock.maxConcurrent, 3);

    const { runner: r2, agent: a2 } = setup({ nodes: [node('a')] }, say('ok', 30));
    const active = [1, 2, 3, 4, 5].map((i) => r2.start(a2, `ticket-${i}`)!);
    assert.equal(active.every(Boolean), true, '前 5 個並行實例都可啟動');
    assert.equal(r2.start(a2, 'ticket-6'), null, '第 6 個並行實例被拒');
    await Promise.all(active.map((x) => x.done));
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
    assert.equal(run.nodeStates.a.output, 'PART2');
    assert.equal(mock.calls[1].options.sessionId, 's1');
    assert.equal(mock.calls[1].options.resume, true);
    assert.match(mock.calls[2].prompt, /PART2/);
    const users = sessionMessagesDb.list('s1', { afterSeq: null, limit: null }).messages.filter((m) => m.role === 'user');
    assert.ok(users.some((m) => m.content === 'fix it'), '新指示記入節點會話');
  });
});

test('節點輸出只保留最後一段最終回覆，過濾工具調用前的過場白', async () => {
  await withDb(async () => {
    const { runner, agent } = setup({ nodes: [node('a')] }, async ({ writer, sessionId }) => {
      writer.send({ kind: 'text', role: 'assistant', content: '正在查詢工單欄位...', sessionId });
      writer.send({ kind: 'tool_use', id: 't1', toolName: 'Bash', sessionId });
      writer.send({ kind: 'text', role: 'assistant', content: '最終結論報告', sessionId });
    });
    const started = runner.start(agent)!;
    await started.done;
    const run = multiAgentsDb.getRun(agent.id, started.run.id)!;
    assert.equal(run.nodeStates.a.output, '最終結論報告');
  });
});

test('人工確認節點「退回重做」：將修改意見帶回上游節點續接同一 session，完成後再次回到確認節點', async () => {
  await withDb(async () => {
    const gate = { id: 'gate', title: '確認倉庫映射', instruction: '請確認', type: 'approval' as const, dependsOn: ['analyze'] };
    const def = { nodes: [node('analyze'), gate, node('clone', ['gate'])] } as WorkflowDef;
    let analyzeRound = 0;
    const { mock, runner, agent } = setup(def, async (ctx) => {
      if (ctx.prompt.includes('do analyze') || ctx.prompt.includes('退回重做')) {
        analyzeRound += 1;
        await say(analyzeRound === 1 ? 'WRONG_20489' : 'FIXED_20200')(ctx);
      } else {
        await say('CLONED')(ctx);
      }
    });
    const started = runner.start(agent)!;
    await waitFor(() => multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.gate.state === 'waiting_confirmation');
    assert.equal(multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.analyze.output, 'WRONG_20489');

    // 在確認節點點選「退回重做」並附上修改意見
    assert.equal(runner.confirm(started.run.id, 'gate', 'rework', '只分析 20200，其他不管'), true);
    await waitFor(() => multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.analyze.output === 'FIXED_20200'
      && multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.gate.state === 'waiting_confirmation');

    assert.equal(mock.calls.length, 2, '上游節點重跑了一輪');
    assert.equal(mock.calls[1].options.sessionId, 's1', '沿用上游節點原本的 sessionId');
    assert.equal(mock.calls[1].options.resume, true);
    assert.match(mock.calls[1].prompt, /只分析 20200，其他不管/);

    // 修正後在確認節點核准，繼續往後跑 clone
    assert.equal(runner.confirm(started.run.id, 'gate', 'approve', '確認無誤'), true);
    await started.done;
    const finalRun = multiAgentsDb.getRun(agent.id, started.run.id)!;
    assert.equal(finalRun.status, 'succeeded');
    assert.match(mock.calls[2].prompt, /FIXED_20200[\s\S]*確認無誤/);
  });
});

test('確認節點駁回後，在上游節點對話頁追問會自動重啟並流轉回確認節點', async () => {
  await withDb(async () => {
    const gate = { id: 'gate', title: '確認倉庫映射', instruction: '請確認', type: 'approval' as const, dependsOn: ['analyze'] };
    const def = { nodes: [node('analyze'), gate, node('clone', ['gate'])] } as WorkflowDef;
    const { mock, runner, agent } = setup(def, async (ctx) => {
      if (ctx.prompt.includes('do analyze')) await say('WRONG_20489')(ctx);
      else if (ctx.prompt.includes('只分析 20200')) await say('FIXED_20200')(ctx);
      else await say('CLONED')(ctx);
    });
    const started = runner.start(agent)!;
    await waitFor(() => multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.gate.state === 'waiting_confirmation');
    // 使用者在確認節點點了駁回，導致整條 run 結束
    runner.confirm(started.run.id, 'gate', false);
    await started.done;
    assert.equal(multiAgentsDb.getRun(agent.id, started.run.id)!.status, 'failed');

    // 使用者打開上游 analyze 的對話頁（s1）並送出追問
    const cId = '33333333-3333-4333-8333-333333333333';
    const res = await workflowSessions.continueSession('s1', 1, '只分析 20200 就好', cId);
    assert.equal(res, 'continued');

    // 自動重跑 analyze 並再次流轉到 gate 等待確認
    await waitFor(() => multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.gate.state === 'waiting_confirmation');
    const midRun = multiAgentsDb.getRun(agent.id, started.run.id)!;
    assert.equal(midRun.status, 'running');
    assert.equal(midRun.nodeStates.analyze.output, 'FIXED_20200');
    assert.equal(mock.calls[1].options.sessionId, 's1');
    assert.equal(mock.calls[1].options.resume, true);

    // 核准確認節點，完成後續節點
    runner.confirm(started.run.id, 'gate', true, 'OK');
    await waitFor(() => multiAgentsDb.getRun(agent.id, started.run.id)!.status === 'succeeded');
    assert.equal(multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.clone.output, 'CLONED');
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

test('建立器與聊天室成員的會話也不出現在專案會話列表', async () => {
  await withDb(async () => {
    const created = multiAgentsDb.create(1, { kind: 'workflow', name: 'wf', workspacePath: '/proj' });
    multiAgentsDb.setBuilderSession(1, created.id, { provider: 'claude', sessionId: 'builder' });
    multiAgentsDb.setMemberSessions(created.id, { m: { provider: 'codex', model: 'x', sessionId: 'member', lastDeliveredSeq: 0 } });
    for (const id of ['builder', 'member', 'plain']) sessionsDb.createSession(id, 'claude', '/proj', id);
    assert.deepEqual(sessionsDb.getSessionsByProjectPath('/proj').map((r) => r.session_id), ['plain']);
    assert.equal(sessionsDb.countSessionsByProjectPath('/proj'), 1);
    assert.ok(sessionsDb.getSessionById('builder'), '按 id 仍可載入');
  });
});


test('分支退回重做後，所有下游確認節點重新等待確認', async () => {
  await withDb(async () => {
    const gate = (id: string) => ({ id, title: id, instruction: 'approve', type: 'approval' as const, dependsOn: ['a'] });
    const { runner, agent } = setup({ nodes: [node('a'), gate('g1'), gate('g2')] }, say('ok'));
    const started = runner.start(agent)!;
    await waitFor(() => started.run.nodeStates.g1.state === 'waiting_confirmation' && started.run.nodeStates.g2.state === 'waiting_confirmation');
    runner.confirm(started.run.id, 'g1', 'rework', 'fix');
    await waitFor(() => started.run.nodeStates.a.state === 'succeeded' && started.run.nodeStates.g1.state === 'waiting_confirmation');
    const secondGateState = started.run.nodeStates.g2.state;
    runner.confirm(started.run.id, 'g1', true);
    runner.confirm(started.run.id, 'g2', true);
    await started.done;
    assert.equal(secondGateState, 'waiting_confirmation');
    assert.equal(started.run.status, 'succeeded');
  });
});


test('受影響分支仍在執行或等待輸入時拒絕退回重做', async () => {
  await withDb(async () => {
    const gate = { id: 'gate', title: 'gate', instruction: 'approve', type: 'approval' as const, dependsOn: ['a'] };
    const { runner, agent, mock } = setup({ nodes: [node('a'), gate, node('b', ['a'])] },
      async (ctx) => say('ok', ctx.prompt.includes('do b') ? 5000 : 0)(ctx));
    const started = runner.start(agent)!;
    await waitFor(() => started.run.nodeStates.gate.state === 'waiting_confirmation' && Boolean(workflowSessions.get('s2')));
    assert.equal(runner.confirm(started.run.id, 'gate', 'rework'), false);
    await interruptFromChat(mock, 's2');
    await waitFor(() => started.run.nodeStates.b.state === 'waiting_input');
    assert.equal(runner.confirm(started.run.id, 'gate', 'rework'), false);
    assert.equal(started.run.nodeStates.gate.state, 'waiting_confirmation');
    await runner.stop(started.run.id);
    await started.done;
  });
});

test('stopByAgent 等待背景任務真正結束，且停止後延遲到達的 sessionId 不再寫入 workflow_sessions', async () => {
  await withDb(async () => {
    let releaseAbort: (() => void) | null = null;
    let delayedWriter: { setSessionId?: (id: string) => void; send: (d: unknown) => void } | null = null;
    const mock = createMockRuntime(async ({ writer }) => {
      delayedWriter = writer;
      await new Promise<void>((resolve) => { releaseAbort = resolve; });
      writer.setSessionId?.('late-session');
      writer.send({ kind: 'complete', aborted: true, sessionId: 'late-session' });
    });
    const runner = new WorkflowRunner({ resolveRuntime: () => mock.runtime, publish: () => {} });
    const created = multiAgentsDb.create(1, { kind: 'workflow', name: 'wf', workspacePath: '/tmp' });
    const agent = { ...multiAgentsDb.setDefinition(1, created.id, { nodes: [node('a')] })!, userId: 1 };

    runner.start(agent)!;
    await waitFor(() => Boolean(delayedWriter));

    let stopSettled = false;
    const stopPromise = runner.stopByAgent(agent.id).then(() => { stopSettled = true; });
    await tick(15);
    assert.equal(stopSettled, false, '底層節點尚未結束前 stopByAgent 不可提前返回');

    releaseAbort!();
    await stopPromise;
    multiAgentsDb.delete(1, agent.id);
    assert.equal(multiAgentsDb.getWorkflowSession('late-session'), null, '已停止／刪除的工作流不得殘留孤兒會話');
  });
});

test('下游節點處於 waiting_input 時拒絕上游追問與 continueDownstream，且不污染上游狀態', async () => {
  await withDb(async () => {
    const { runner, agent, mock } = setup(
      { nodes: [node('a'), node('b', ['a'])] },
      async (ctx) => say(ctx.prompt.includes('do a') ? 'A1' : 'B1', ctx.prompt.includes('do b') ? 5000 : 0)(ctx),
    );
    const started = runner.start(agent)!;
    await waitFor(() => Boolean(workflowSessions.get('s2')));
    await interruptFromChat(mock, 's2');
    await waitFor(() => started.run.nodeStates.b.state === 'waiting_input');

    // 手動把上游設為 failed 以驗證 continueDownstream 失敗時不會提前把 state 改為 succeeded
    started.run.nodeStates.a.state = 'failed';
    started.run.nodeStates.a.error = 'manual';

    const contRes = await workflowSessions.continueSession('s1', 1, '補充一點', 'c-follow');
    assert.equal(contRes, 'busy', '下游仍在 waiting_input 時上游對話追問應回 busy');

    assert.equal(runner.continueDownstream(agent.id, started.run.id, 'a'), false, '下游 waiting_input 時拒絕繼續流轉');
    assert.equal(started.run.nodeStates.a.state, 'failed', '前置檢查未通過時不可污染節點狀態');

    await runner.stop(started.run.id);
    await started.done;
  });
});

test('工作流節點對話頁發送截圖（images）時，圖片一併傳給 runtime.start 並記入 session_messages', async () => {
  await withDb(async () => {
    const { runner, agent, mock } = setup({ nodes: [node('a')] }, say('SAW_IMAGE'));
    const started = runner.start(agent)!;
    await started.done;

    const sampleImages = [{ name: 'screen.png', data: 'data:image/png;base64,iVBORw0KGgo=' }];
    const cId = '44444444-4444-4444-8444-444444444444';
    const res = await workflowSessions.continueSession('s1', 1, '這張截圖合理嗎？', cId, sampleImages);
    assert.equal(res, 'continued');
    await waitFor(() => mock.calls.length === 2 && multiAgentsDb.getRun(agent.id, started.run.id)!.status === 'succeeded');

    assert.deepEqual(mock.calls[1].options.images, sampleImages, '圖片應傳入 runtime.start options.images');
    const userMsg = sessionMessagesDb.list('s1', { afterSeq: null, limit: null }).messages.find((m) => m.id === `user:${cId}`);
    assert.equal((userMsg?.images as Array<{ name: string }> | undefined)?.[0]?.name, 'screen.png', '圖片中繼資料應記入 session_messages');
  });
});

test('上游確認節點因先前重跑並停止而處於 failed 時，直接在下游已執行節點對話頁追問仍能立即執行該節點', async () => {
  await withDb(async () => {
    const gate = { id: 'gate_test', title: '確認測試', instruction: 'ok?', type: 'approval' as const, dependsOn: ['test_submit'] };
    const def = { nodes: [node('test_submit'), gate, node('review1', ['gate_test'])] } as WorkflowDef;
    const { runner, agent, mock } = setup(def, async (ctx) => {
      if (ctx.prompt.includes('MR block')) await say('MR_FIXED')(ctx);
      else if (ctx.prompt.includes('do review1')) await say('REVIEW_V1')(ctx);
      else await say('TEST_OK')(ctx);
    });
    const started = runner.start(agent)!;
    await waitFor(() => multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.gate_test.state === 'waiting_confirmation');
    runner.confirm(started.run.id, 'gate_test', true);
    await started.done;

    const r1SessionId = multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.review1.sessionId!;
    assert.equal(r1SessionId, 's2');

    // 使用者回到上游 test_submit (s1) 追問，推進到 gate_test 後按停止（導致 gate_test=failed, review1=skipped）
    await workflowSessions.continueSession('s1', 1, '怎麼拉起前端？', '55555555-5555-4555-8555-555555555555');
    await waitFor(() => multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.gate_test.state === 'waiting_confirmation');
    await runner.stop(started.run.id);
    await waitFor(() => multiAgentsDb.getRun(agent.id, started.run.id)!.status === 'stopped');
    assert.equal(multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.gate_test.state, 'failed');
    assert.equal(multiAgentsDb.getRun(agent.id, started.run.id)!.nodeStates.review1.state, 'skipped');

    // 使用者打開下游 review1 (s2) 的對話頁發送「MR block 了，fix 下」
    const res = await workflowSessions.continueSession(r1SessionId, 1, 'MR block 了，fix 下', '66666666-6666-4666-8666-666666666666');
    assert.equal(res, 'continued');
    await waitFor(() => multiAgentsDb.getRun(agent.id, started.run.id)!.status === 'succeeded');

    const finalRun = multiAgentsDb.getRun(agent.id, started.run.id)!;
    assert.equal(finalRun.nodeStates.review1.state, 'succeeded');
    assert.equal(finalRun.nodeStates.review1.output, 'MR_FIXED');
    assert.equal(mock.calls.at(-1)?.options.sessionId, 's2');
    assert.equal(mock.calls.at(-1)?.prompt, 'MR block 了，fix 下');
  });
});
