import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
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
