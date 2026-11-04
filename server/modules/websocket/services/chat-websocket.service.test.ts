import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

type Sent = Record<string, any>;

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

function connect(runtimes: Partial<Record<LLMProvider, IProviderRuntime>>) {
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
    resolveToolApproval: () => {},
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
  await send({ type: 'chat-command', provider: 'codex', command: 'hi', options: { model: 'm' } });
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
  await send({ type: 'abort-session', provider: 'codex', sessionId: 's1' });
  assert.equal(ws.sent.filter((m) => m.kind === 'complete').length, 0);
});

test('abort：emitsTerminal 為 false 時補送一次結束事件', async () => {
  const { ws, send } = connect({ claude: fakeRuntime({ abort: async () => ({ ok: true, emitsTerminal: false }) }) });
  await send({ type: 'abort-session', provider: 'claude', sessionId: 's1' });
  const completes = ws.sent.filter((m) => m.kind === 'complete');
  assert.equal(completes.length, 1);
  assert.equal(completes[0].aborted, true);
  assert.equal(completes[0].success, true);
});

test('abort 失敗時即使 runtime 會自送結束事件，也補送一次失敗結果', async () => {
  const { ws, send } = connect({ antigravity: fakeRuntime({ abort: async () => ({ ok: false, emitsTerminal: true }) }) });
  await send({ type: 'abort-session', provider: 'antigravity', sessionId: 's1' });
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
  await send({ type: 'chat-steer', provider: 'claude', sessionId: 's1', text: 'hi', clientId: 'c1' });
  assert.deepEqual(ws.sent[0], { type: 'steer-rejected', provider: 'claude', sessionId: 's1', clientId: 'c1', text: 'hi', reason: 'unsupported' });
});

test('chat-steer：分派到 runtime.steer 並依結果回覆', async () => {
  const calls: unknown[] = [];
  let ok = true;
  const { ws, send } = connect({ codex: fakeRuntime({ steer: async (...args) => { calls.push(args); return ok ? { ok } : { ok, reason: 'turn_not_started' }; } }) });
  await send({ type: 'chat-steer', provider: 'codex', sessionId: 's1', text: 'hi', clientId: 'c1' });
  ok = false;
  await send({ type: 'chat-steer', provider: 'codex', sessionId: 's1', text: 'again', clientId: 'c2' });
  assert.deepEqual(calls, [['s1', 7, 'hi'], ['s1', 7, 'again']]);
  assert.equal(ws.sent[0].type, 'steer-accepted');
  assert.deepEqual(ws.sent[1], { type: 'steer-rejected', provider: 'codex', sessionId: 's1', clientId: 'c2', text: 'again', reason: 'turn_not_started' });
});
