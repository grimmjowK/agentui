import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { closeConnection, initializeDatabase, sessionMessagesDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { isSessionLogActive } from '@/modules/websocket/services/logging-writer.service.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import { workflowSessions, type LiveWorkflowSession } from '@/shared/workflow-session-registry.js';
import type { LLMProvider } from '@/shared/types.js';

type Sent = Record<string, any>;
const CLIENT_ID_1 = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID_2 = '22222222-2222-4222-8222-222222222222';
let databaseDirectory = '';
let previousDatabasePath: string | undefined;

before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  databaseDirectory = await mkdtemp(path.join(tmpdir(), 'chat-logging-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();
});

after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(databaseDirectory, { recursive: true, force: true });
});

function fakeRuntime(overrides: Partial<IProviderRuntime> = {}): IProviderRuntime {
  return {
    start: async () => {},
    abort: async () => ({ ok: true, emitsTerminal: false }),
    isActive: () => false,
    reconnect: () => false,
    listActive: () => [],
    ...overrides,
  };
}

function connect(
  runtimes: Partial<Record<LLMProvider, IProviderRuntime>>,
  resolveToolApproval: (...args: any[]) => boolean = () => true,
) {
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [] as Sent[],
    send(raw: string) { this.sent.push(JSON.parse(raw)); },
  });
  const providers = Object.entries(runtimes).map(([id, runtime]) => ({ id: id as LLMProvider, runtime: runtime! }));
  handleChatConnection(ws as any, { user: { id: 7 } } as any, {
    providerRegistry: {
      listProviders: () => providers,
      resolveProvider: (provider: string) => {
        const found = providers.find((p) => p.id === provider);
        if (!found) throw new Error(`Unsupported provider "${provider}".`);
        return found;
      },
    },
    resolveCodexApproval: () => true,
    resolveToolApproval,
  });
  const send = async (message: Sent) => {
    ws.emit('message', Buffer.from(JSON.stringify(message)));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ws, send };
}

test('chat-command 依 provider 分派到 runtime.start', async () => {
  const calls: unknown[] = [];
  const { send } = connect({ codex: fakeRuntime({ start: async (...args) => { calls.push(args.slice(0, 2)); } }) });
  await send({ type: 'chat-command', provider: 'codex', command: 'hi', clientId: CLIENT_ID_1, options: { model: 'm' } });
  assert.deepEqual(calls, [['hi', { model: 'm' }]]);
});

test('未註冊的 provider 回傳錯誤', async () => {
  const { ws, send } = connect({ claude: fakeRuntime() });
  await send({ type: 'chat-command', provider: 'gemini', command: 'hi' });
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].type, 'error');
  assert.match(ws.sent[0].error, /gemini/);
});

test('abort：emitsTerminal 為 true 時不補送結束事件', async () => {
  const { ws, send } = connect({ codex: fakeRuntime({ abort: async () => ({ ok: true, emitsTerminal: true }) }) });
  await send({ type: 'abort-session', provider: 'codex', sessionId: 's-terminal' });
  assert.equal(ws.sent.filter((m) => m.kind === 'complete').length, 0);
});

test('abort：emitsTerminal 為 false 時補送一次結束事件', async () => {
  const { ws, send } = connect({ claude: fakeRuntime({ abort: async () => ({ ok: true, emitsTerminal: false }) }) });
  await send({ type: 'abort-session', provider: 'claude', sessionId: 's-no-terminal' });
  const completes = ws.sent.filter((m) => m.kind === 'complete');
  assert.equal(completes.length, 1);
  assert.equal(completes[0].aborted, true);
  assert.equal(completes[0].success, true);
});

test('abort 失敗時即使 runtime 會自送結束事件，也補送一次失敗結果', async () => {
  const { ws, send } = connect({ antigravity: fakeRuntime({ abort: async () => ({ ok: false, emitsTerminal: true }) }) });
  await send({ type: 'abort-session', provider: 'antigravity', sessionId: 's-fail' });
  const completes = ws.sent.filter((m) => m.kind === 'complete');
  assert.equal(completes.length, 1);
  assert.equal(completes[0].success, false);
});

test('get-active-sessions 的鍵等於已註冊 provider', async () => {
  const { ws, send } = connect({
    claude: fakeRuntime({ listActive: () => ['a'] }),
    cursor: fakeRuntime(),
    codex: fakeRuntime(),
    antigravity: fakeRuntime(),
  });
  await send({ type: 'get-active-sessions' });
  assert.deepEqual(Object.keys(ws.sent[0].sessions).sort(), ['antigravity', 'claude', 'codex', 'cursor']);
  assert.deepEqual(ws.sent[0].sessions.claude, ['a']);
});

test('check-session-status 透過 runtime.reconnect 回報狀態', async () => {
  const { ws, send } = connect({ cursor: fakeRuntime({ reconnect: (id) => id === 'live' }) });
  await send({ type: 'check-session-status', provider: 'cursor', sessionId: 'live' });
  assert.deepEqual(ws.sent[0], { type: 'session-status', sessionId: 'live', provider: 'cursor', isProcessing: true });
});

test('chat-steer：provider 未實作時回傳 steer-rejected', async () => {
  const { ws, send } = connect({ claude: fakeRuntime() });
  await send({ type: 'chat-steer', provider: 'claude', sessionId: 's1', text: 'hi', clientId: CLIENT_ID_1 });
  assert.deepEqual(ws.sent[0], { type: 'steer-rejected', provider: 'claude', sessionId: 's1', clientId: CLIENT_ID_1, text: 'hi', reason: 'unsupported' });
});

test('chat-steer：分派到 runtime.steer 並依結果回覆', async () => {
  const calls: unknown[] = [];
  let ok = true;
  const { ws, send } = connect({ codex: fakeRuntime({ steer: async (...args) => { calls.push(args); return ok ? { ok } : { ok, reason: 'turn_not_started' }; } }) });
  await send({ type: 'chat-steer', provider: 'codex', sessionId: 's1', text: 'hi', clientId: CLIENT_ID_1 });
  ok = false;
  await send({ type: 'chat-steer', provider: 'codex', sessionId: 's1', text: 'again', clientId: CLIENT_ID_2 });
  assert.deepEqual(calls, [['s1', 7, 'hi'], ['s1', 7, 'again']]);
  assert.equal(ws.sent[0].kind, 'text');
  assert.equal(ws.sent[0].id, `user:${CLIENT_ID_1}`);
  assert.equal(ws.sent[1].type, 'steer-accepted');
  assert.deepEqual(ws.sent[2], { type: 'steer-rejected', provider: 'codex', sessionId: 's1', clientId: CLIENT_ID_2, text: 'again', reason: 'turn_not_started' });
});

test('claude-permission-response 帶上呼叫者 userId；被拒時回覆警告', async () => {
  const calls: unknown[] = [];
  const { ws, send } = connect({ claude: fakeRuntime() }, (...args) => { calls.push(args.slice(0, 2)); return false; });
  await send({ type: 'claude-permission-response', requestId: 'r1', sessionId: 's1', allow: true });
  assert.deepEqual(calls, [['r1', 7]]);
  assert.equal(ws.sent[0].kind, 'task_notification');
  assert.equal(ws.sent[0].status, 'warning');
});

test('permission-decision 分派到 runtime.resolveApproval；未實作或被拒時回覆警告', async () => {
  const calls: unknown[] = [];
  const { ws, send } = connect({
    antigravity: fakeRuntime({ resolveApproval: (...args) => { calls.push(args); return args[2] === 'allow'; } }),
    claude: fakeRuntime(),
  });
  await send({ type: 'permission-decision', provider: 'antigravity', requestId: 'r1', sessionId: 's1', decision: 'allow' });
  assert.deepEqual(calls, [['r1', 7, 'allow']]);
  assert.equal(ws.sent.length, 0);
  await send({ type: 'permission-decision', provider: 'antigravity', requestId: 'r1', sessionId: 's1', decision: 'bogus' });
  assert.equal(ws.sent.at(-1)?.status, 'warning');
  await send({ type: 'permission-decision', provider: 'claude', requestId: 'r2', sessionId: 's1', decision: 'allow' });
  assert.equal(ws.sent.at(-1)?.status, 'warning');
});

test('get-pending-permissions 不帶 sessionId 時跨 provider 匯總，帶 sessionId 時只查該會話', async () => {
  const calls: unknown[] = [];
  const pending = (provider: string) => (userId: unknown, sessionId?: string) => {
    calls.push([provider, userId, sessionId]);
    return [{ requestId: `${provider}-1`, toolName: 'Bash', sessionId: 's1', receivedAt: 'now' }];
  };
  const { ws, send } = connect({
    claude: fakeRuntime({ getPendingApprovals: pending('claude') }),
    codex: fakeRuntime({ getPendingApprovals: pending('codex') }),
    cursor: fakeRuntime(),
  });
  await send({ type: 'get-pending-permissions' });
  assert.equal(ws.sent[0].sessionId, undefined);
  assert.deepEqual(ws.sent[0].data.map((item: any) => [item.provider, item.requestId]), [['claude', 'claude-1'], ['codex', 'codex-1']]);
  await send({ type: 'get-pending-permissions', sessionId: 's1' });
  assert.equal(ws.sent[1].sessionId, 's1');
  assert.deepEqual(calls, [['claude', 7, undefined], ['codex', 7, undefined], ['claude', 7, 's1'], ['codex', 7, 's1']]);
});

test('abort-session、check-session-status 與 recordUserMessage 衝突不會洩漏 activeWriters', async () => {
  // 1. abort-session with emitsTerminal: true when no active writer exists
  const { send: sendAbort } = connect({
    codex: fakeRuntime({ abort: async () => ({ ok: true, emitsTerminal: true }) }),
  });
  await sendAbort({ type: 'abort-session', provider: 'codex', sessionId: 'leak-abort-1' });
  assert.equal(isSessionLogActive('leak-abort-1'), false);

  // 2. check-session-status when reconnect returns true but no active writer was registered from chat-command
  const { send: sendStatus } = connect({
    cursor: fakeRuntime({ reconnect: () => true }),
  });
  await sendStatus({ type: 'check-session-status', provider: 'cursor', sessionId: 'leak-status-1' });
  assert.equal(isSessionLogActive('leak-status-1'), false);

  // 3. chat-command where clientId conflicts with another user's message
  sessionMessagesDb.insertUserIfAbsent(
    'leak-conflict-1',
    {
      id: `user:${CLIENT_ID_1}`,
      sessionId: 'leak-conflict-1',
      timestamp: new Date().toISOString(),
      provider: 'codex',
      kind: 'text',
      role: 'user',
      content: 'other user msg',
    },
    999,
  );
  const { ws: conflictWs, send: sendConflict } = connect({ codex: fakeRuntime() });
  await sendConflict({
    type: 'chat-command',
    provider: 'codex',
    command: 'hi',
    clientId: CLIENT_ID_1,
    options: { sessionId: 'leak-conflict-1' },
  });
  assert.equal(conflictWs.sent.at(-1)?.type, 'error');
  assert.equal(isSessionLogActive('leak-conflict-1'), false);
});


// ---------------- 工作流節點會話：旁觀不搶占（node-live-session D2/D4/D5） ----------------

function liveNode(sessionId: string, overrides: Partial<LiveWorkflowSession> = {}) {
  const calls = { interrupted: 0, resumed: [] as string[] };
  const entry: LiveWorkflowSession = {
    multiAgentId: 'ma', runId: 'r', nodeId: 'n', nodeTitle: 'N', userId: 7,
    state: () => 'running',
    markUserInterrupted: () => { calls.interrupted += 1; },
    resume: (text) => { calls.resumed.push(text); return false; },
    ...overrides,
  };
  workflowSessions.register(sessionId, entry);
  return { entry, calls, done: () => workflowSessions.unregister(sessionId, entry) };
}

test('check-session-status：執行中的節點會話只重播，不改送也不 reconnect', async () => {
  const node = liveNode('wf-live');
  let reconnects = 0;
  const { ws, send } = connect({ claude: fakeRuntime({ reconnect: () => { reconnects += 1; return true; } }) });
  try {
    await send({ type: 'check-session-status', provider: 'claude', sessionId: 'wf-live', afterSeq: 0 });
    assert.equal(reconnects, 0);
    const status = ws.sent.find((m) => m.type === 'session-status');
    assert.equal(status?.isProcessing, true);
  } finally {
    node.done();
  }
});

test('chat-command 對執行中節點會話被拒；等待指示時交給執行器續接', async () => {
  let starts = 0;
  let resumable = false;
  const node = liveNode('wf-cmd', { resume: (text) => { if (resumable) node.calls.resumed.push(text); return resumable; } });
  const { ws, send } = connect({ claude: fakeRuntime({ start: async () => { starts += 1; } }) });
  try {
    await send({ type: 'chat-command', provider: 'claude', command: 'x', clientId: CLIENT_ID_1, options: { sessionId: 'wf-cmd' } });
    assert.equal(ws.sent.at(-1)?.status, 'warning');
    resumable = true;
    await send({ type: 'chat-command', provider: 'claude', command: 'fix', clientId: CLIENT_ID_2, options: { sessionId: 'wf-cmd' } });
    assert.deepEqual(node.calls.resumed, ['fix']);
    assert.equal(starts, 0, '節點會話不走一般啟動');
  } finally {
    node.done();
  }
});

test('abort-session 對節點會話標記使用者中斷', async () => {
  const node = liveNode('wf-abort');
  const { send } = connect({ claude: fakeRuntime() });
  try {
    await send({ type: 'abort-session', provider: 'claude', sessionId: 'wf-abort' });
    assert.equal(node.calls.interrupted, 1);
  } finally {
    node.done();
  }
});
