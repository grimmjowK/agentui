import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, multiAgentsDb } from '@/modules/database/index.js';
import { agentCallTiming } from '@/modules/multi-agent/services/agent-call.js';
import { ChatroomDispatcher, needsNewSession, settingNotes } from '@/modules/multi-agent/services/chatroom-dispatcher.js';

import { defaultChatRules, type ChatMember, type ChatroomDef } from '../../../../shared/multiAgent.js';

import { createMockRuntime, say, tick, type Script } from './mock-runtime.js';

async function withDb(run: () => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'chatroom-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try { await run(); } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const member = (id: string, name: string, extra: Partial<ChatMember> = {}): ChatMember =>
  ({ id, name, persona: `${name} persona`, provider: 'claude', model: 'sonnet', ...extra });

function setup(def: ChatroomDef, script: Script, timeoutMs?: number) {
  const mock = createMockRuntime(script);
  const dispatcher = new ChatroomDispatcher({ resolveRuntime: () => mock.runtime, publish: () => {}, timeoutMs });
  const created = multiAgentsDb.create(1, { kind: 'chatroom', name: 'room', workspacePath: '/tmp' });
  const agent = () => ({ ...multiAgentsDb.getById(created.id)! });
  multiAgentsDb.setDefinition(1, created.id, def);
  return { mock, dispatcher, agent, id: created.id };
}

const replies = (id: string) => multiAgentsDb.listMessages(id).filter((m) => m.authorKind !== 'user');
const twoMembers = (rules = {}) => ({ members: [member('pm', '產品經理'), member('rv', '審稿人')], rules: { ...defaultChatRules(2), ...rules } });

test('@ 單一角色只有該成員回覆；@所有人 依序回覆', async () => {
  await withDb(async () => {
    const { dispatcher, agent, id, mock } = setup(twoMembers(), async (ctx) => say(ctx.prompt.match(/以「(.+?)」/)![1])(ctx));
    dispatcher.send(agent(), '@產品經理 評估');
    await dispatcher.idle(id);
    assert.deepEqual(replies(id).map((m) => m.content), ['產品經理']);
    dispatcher.send(agent(), '@所有人 說說');
    await dispatcher.idle(id);
    assert.deepEqual(replies(id).map((m) => m.content), ['產品經理', '產品經理', '審稿人']);
    assert.equal(mock.calls[0].options.permissionMode, 'plan', 'Claude 成員預設 plan');
  });
});

test('忙碌時排隊，依序處理；取消排隊訊息不觸發回覆', async () => {
  await withDb(async () => {
    const { dispatcher, agent, id, mock } = setup(twoMembers({ unmentionedBehavior: 'all' }), say('ok', 30));
    dispatcher.send(agent(), '@產品經理 一');
    const second = dispatcher.send(agent(), '@審稿人 二');
    const third = dispatcher.send(agent(), '@審稿人 三');
    assert.equal(multiAgentsDb.getMessage(id, second.id)?.status, 'queued');
    assert.equal(multiAgentsDb.deleteQueuedMessage(id, third.id), true);
    await dispatcher.idle(id);
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.maxConcurrent, 1, '同聊天室不並行');
    const order = multiAgentsDb.listMessages(id).map((m) => `${m.authorKind}:${m.content}`);
    assert.deepEqual(order, ['user:@產品經理 一', 'member:ok', 'user:@審稿人 二', 'member:ok']);
  });
});

test('成員回覆不按字數硬截斷，完整保留輸出並沿用 session', async () => {
  await withDb(async () => {
    const { dispatcher, agent, id, mock } = setup(twoMembers({ maxReplyChars: 5 }), say('一二三四五六七八'));
    dispatcher.send(agent(), '@產品經理 長一點');
    await dispatcher.idle(id);
    const [reply] = replies(id);
    assert.equal(reply.content, '一二三四五六七八');
    assert.equal(reply.finishReason, null);
    dispatcher.send(agent(), '@產品經理 再來');
    await dispatcher.idle(id);
    assert.equal(mock.calls[1].options.sessionId, 's1');
  });
});

test('AI 互相 @ 受上限限制並插入系統訊息；關閉時不觸發', async () => {
  await withDb(async () => {
    const ping: Script = async (ctx) => say(ctx.prompt.includes('以「產品經理」') ? '@審稿人 你看' : '@產品經理 你看')(ctx);
    const on = setup(twoMembers({ allowAiMentions: true, maxAiRepliesPerTurn: 3 }), ping);
    on.dispatcher.send(on.agent(), '@產品經理 開始');
    await on.dispatcher.idle(on.id);
    const r = replies(on.id);
    assert.equal(r.filter((m) => m.authorKind === 'member').length, 3);
    assert.equal(r.at(-1)?.content, '已達本輪發言上限');

    const off = setup(twoMembers({ allowAiMentions: false }), ping);
    off.dispatcher.send(off.agent(), '@產品經理 開始');
    await off.dispatcher.idle(off.id);
    assert.equal(replies(off.id).length, 1);
  });
});

test('停止本輪：目前回覆中止、待發言成員不再回覆；舊 turnId 停止無副作用', async () => {
  await withDb(async () => {
    const { dispatcher, agent, id, mock } = setup(twoMembers(), say('慢慢說', 2000));
    dispatcher.send(agent(), '@所有人 討論');
    await tick(20);
    const turnId = multiAgentsDb.getActiveTurn(id)!.id;
    assert.equal(await dispatcher.stop(id, turnId), true);
    await dispatcher.idle(id);
    assert.equal(mock.calls.length, 1);
    assert.equal(replies(id)[0].finishReason, 'stopped');
    assert.equal(await dispatcher.stop(id, turnId), false);
  });
});

test('超時取消並計入上限', async () => {
  await withDb(async () => {
    agentCallTiming.tickMs = 5;
    try {
      const { dispatcher, agent, id } = setup(twoMembers({ maxAiRepliesPerTurn: 1 }), async ({ aborted }) => {
        while (!aborted()) await tick(2);
      }, 30);
      dispatcher.send(agent(), '@所有人 想很久');
      await dispatcher.idle(id);
      const r = replies(id);
      assert.equal(r[0].finishReason, 'timeout');
      assert.equal(r[0].status, 'error');
      assert.equal(r.filter((m) => m.authorKind === 'member').length, 1);
    } finally {
      agentCallTiming.tickMs = 1000;
    }
  });
});

test('session 規則：改人設沿用 session 並附說明；換 provider 重建；續接失敗重建重試', async () => {
  await withDb(async () => {
    let failResume = false;
    const { dispatcher, agent, id, mock } = setup({ members: [member('pm', '產品經理')], rules: defaultChatRules(1) }, async (ctx) => {
      if (failResume && ctx.options.sessionId) {
        ctx.writer.send({ kind: 'error', content: 'resume failed', sessionId: ctx.sessionId });
        return;
      }
      await say('ok')(ctx);
    });
    dispatcher.send(agent(), '第一句');
    await dispatcher.idle(id);

    const before = agent().definition as ChatroomDef;
    const after: ChatroomDef = { ...before, members: [{ ...before.members[0], persona: '新人設' }] };
    multiAgentsDb.setDefinition(1, id, after);
    dispatcher.send(agent(), '第二句');
    await dispatcher.idle(id);
    assert.equal(mock.calls[1].options.sessionId, 's1');
    assert.match(mock.calls[1].prompt, /人設已更新為：新人設/);
    assert.doesNotMatch(mock.calls[1].prompt, /第一句/, '續接只送增量');
    assert.match(mock.calls[1].prompt, /第二句/);

    failResume = true;
    dispatcher.send(agent(), '第三句');
    await dispatcher.idle(id);
    assert.equal(mock.calls[2].options.sessionId, 's1');
    assert.equal(mock.calls[3].options.sessionId, null, '續接失敗後重建');
    assert.match(mock.calls[3].prompt, /第一句[\s\S]*第三句/, '重建時重播紀錄');
  });
});

test('needsNewSession 依 provider 與 resumeAcrossModels', () => {
  const s = { provider: 'claude' as const, model: 'sonnet', sessionId: 'x', lastDeliveredSeq: 0 };
  assert.equal(needsNewSession(undefined, member('a', 'a')), true);
  assert.equal(needsNewSession(s, member('a', 'a')), false);
  assert.equal(needsNewSession(s, member('a', 'a', { model: 'opus' })), false, 'Claude 可跨模型續接');
  assert.equal(needsNewSession(s, member('a', 'a', { provider: 'codex', model: 'gpt' })), true);
  assert.equal(needsNewSession({ ...s, provider: 'codex', model: 'a' }, member('a', 'a', { provider: 'codex', model: 'b' })), true);
});

test('settingNotes：依目前定義比對，改回原值不提示', () => {
  const def: ChatroomDef = { members: [member('pm', '產品經理')], rules: defaultChatRules(1) };
  const seen = { name: '產品經理', persona: '產品經理 persona', rulesText: '', maxReplyChars: 800, allowAiMentions: false };
  const session = { provider: 'claude' as const, model: 'sonnet', sessionId: 'x', lastDeliveredSeq: 0, seen };
  assert.deepEqual(settingNotes(session, def.members[0], def), []);
  const changed: ChatroomDef = { ...def, rules: { ...def.rules, allowAiMentions: true } };
  assert.deepEqual(settingNotes(session, def.members[0], changed), ['現在可以 @ 其他成員請其接話']);
});


test('刪除前停止並等待，不派發排隊訊息', async () => {
  await withDb(async () => {
    const { dispatcher, agent, id, mock } = setup(twoMembers(), say('ok', 300));
    dispatcher.send(agent(), '@產品經理 first');
    dispatcher.send(agent(), '@產品經理 second');
    await dispatcher.stopAndWait(id);
    const busyAfterStop = dispatcher.isBusy(id);
    const callsAfterStop = mock.calls.length;
    multiAgentsDb.delete(1, id);
    await dispatcher.idle(id);
    assert.equal(busyAfterStop, false);
    assert.equal(callsAfterStop, 1);
    assert.deepEqual(multiAgentsDb.listMessages(id), []);
  });
});

test('群規文字被清空時提示「群規已清除」', () => {
  const def: ChatroomDef = { members: [member('pm', '產品經理')], rules: { ...defaultChatRules(1), text: '' } };
  const seen = { name: '產品經理', persona: '產品經理 persona', rulesText: '只能用英文', maxReplyChars: 800, allowAiMentions: false };
  const session = { provider: 'claude' as const, model: 'sonnet', sessionId: 'x', lastDeliveredSeq: 0, seen };
  assert.deepEqual(settingNotes(session, def.members[0], def), ['群規已清除']);
});

test('標記刪除中時拒絕新訊息，且回合中移除成員後發言結束不會把已刪除成員寫回 member_sessions', async () => {
  await withDb(async () => {
    let finishSpeak: (() => void) | null = null;
    const { dispatcher, agent, id } = setup(twoMembers(), async ({ writer, sessionId }) => {
      await new Promise<void>((resolve) => { finishSpeak = resolve; });
      writer.send({ kind: 'text', role: 'assistant', content: 'done', sessionId });
      writer.send({ kind: 'complete', exitCode: 0, sessionId });
    });

    dispatcher.send(agent(), '@審稿人 請看');
    await tick(15);

    // 回合進行中從定義裡移除「審稿人 (rv)」
    const nextDef: ChatroomDef = { members: [member('pm', '產品經理')], rules: defaultChatRules(1) };
    multiAgentsDb.setDefinition(1, id, nextDef);
    dispatcher.pruneMemberSessions(id, nextDef);

    finishSpeak!();
    await dispatcher.idle(id);
    assert.equal(multiAgentsDb.getMemberSessions(id).rv, undefined, '已從定義移除的成員不可殘留 session');

    dispatcher.markDeleting(id);
    assert.equal(dispatcher.isDeleting(id), true);
    assert.throws(() => dispatcher.send(agent(), '@產品經理 再發一則'), /deleting/i);
    dispatcher.clearDeleting(id);
  });
});

test('同一聊天室配置下可開啟多個獨立對話，並行執行且訊息與成員 session 互不干擾', async () => {
  await withDb(async () => {
    const { dispatcher, agent, id, mock } = setup(
      twoMembers(),
      async (ctx) => say(ctx.prompt.includes('話題 A') ? 'A-REPLY' : 'B-REPLY', 40)(ctx),
    );
    const threadB = multiAgentsDb.createThread(id);
    dispatcher.send(agent(), '@產品經理 話題 A', 'default');
    dispatcher.send(agent(), '@產品經理 話題 B', threadB.id);
    await dispatcher.idle(id);

    assert.equal(mock.maxConcurrent, 2, '兩個對話可並行執行');
    const msgsA = multiAgentsDb.listMessages(id, { threadId: 'default' });
    const msgsB = multiAgentsDb.listMessages(id, { threadId: threadB.id });
    assert.deepEqual(msgsA.map((m) => m.content), ['@產品經理 話題 A', 'A-REPLY']);
    assert.deepEqual(msgsB.map((m) => m.content), ['@產品經理 話題 B', 'B-REPLY']);
    assert.notEqual(
      multiAgentsDb.getMemberSessions(id, 'default').pm?.sessionId,
      multiAgentsDb.getMemberSessions(id, threadB.id).pm?.sessionId,
      '不同對話各自持有獨立的成員 sessionId',
    );
    const threads = multiAgentsDb.listThreads(id);
    assert.equal(threads.length, 2);
  });
});
