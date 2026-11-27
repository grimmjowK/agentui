import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import ts from 'typescript';

import type { useChatroom } from './useChatroom';

// 執行實際 hook 回呼，控制 HTTP 完成順序；不需要瀏覽器或真實 API。
function harness() {
  const slots: any[] = [];
  let cursor = 0;
  const requests: Array<(data: unknown) => void> = [];
  let threadsList: Array<{ id: string; title: string; isArchived?: boolean }> = [];
  let createdCount = 0;
  const react = {
    useState(initial: any) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial: any) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useCallback(fn: unknown) { return fn; },
    useEffect() {},
  };
  const api = { multiAgent: {
    messages: () => new Promise((resolve) => requests.push(resolve)),
    listThreads: async () => ({ threads: threadsList, activeTurns: {} }),
    createThread: async () => {
      const created = { id: createdCount++ === 0 ? 'new-thread' : `new-thread-${createdCount}`, title: '新對話', isArchived: false };
      threadsList = [created, ...threadsList];
      return created;
    },
    deleteThread: async (_id: string, threadId: string, opts?: { force?: boolean }) => {
      if (opts?.force) {
        threadsList = threadsList.filter((t) => t.id !== threadId);
        return { id: threadId, archived: false, deleted: true };
      }
      threadsList = threadsList.map((t) => (t.id === threadId ? { ...t, isArchived: true } : t));
      return { id: threadId, archived: true, deleted: false };
    },
  } };
  const source = readFileSync(new URL('./useChatroom.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { useChatroom?: typeof useChatroom } = {};
  new Function('require', 'exports', js)((name: string) => {
    if (name === 'react') return react;
    if (name.includes('WebSocketContext')) return { useWebSocket: () => ({ latestMessage: null, isConnected: true }) };
    if (name.includes('utils/api')) return { api };
    if (name.includes('fetchJson')) return { readData: (promise: unknown) => promise };
    throw new Error(`Unexpected import: ${name}`);
  }, exports);
  return {
    requests,
    setThreadsList(next: Array<{ id: string; title: string; isArchived?: boolean }>) { threadsList = next; },
    render() { cursor = 0; return exports.useChatroom!('room'); },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const message = (threadId: string) => ({ id: threadId, threadId, seq: 10 });

test('建立新對話後，舊對話載入回應不得覆蓋訊息', async () => {
  const h = harness();
  h.render().selectThread('old-thread');
  await h.render().createThread();
  h.requests[0]({ messages: [message('old-thread')], activeTurnId: null });
  await tick();
  const chat = h.render();
  assert.equal(chat.selectedThreadId, 'new-thread');
  assert.deepEqual(chat.messages, []);
  assert.equal(chat.loading, false);
});

test('切換對話後，舊對話分頁回應不得合併到新對話', async () => {
  const h = harness();
  h.render().selectThread('old-thread');
  h.requests[0]({ messages: [message('old-thread')], activeTurnId: null });
  await tick();
  const earlier = h.render().loadEarlier();
  h.render().selectThread('other-thread');
  h.requests[2]({ messages: [message('other-thread')], activeTurnId: null });
  await tick();
  h.requests[1]({ messages: [{ ...message('old-thread'), id: 'older', seq: 1 }] });
  await earlier;
  assert.deepEqual(h.render().messages, [message('other-thread')]);
});

test('永久刪除最後一個活躍對話且尚有已歸檔對話時，自動建立新對話而不誤跳入已歸檔對話', async () => {
  const h = harness();
  h.setThreadsList([
    { id: 'active-1', title: '目前活躍', isArchived: false },
    { id: 'arch-1', title: '舊歸檔', isArchived: true },
  ]);
  h.render().selectThread('active-1');
  h.requests.pop()!({ messages: [], activeTurnId: null });
  await tick();

  const deleting = h.render().deleteThread('active-1', { force: true });
  await tick();
  await tick();
  // reloadMessages 為新建立的對話拉取訊息
  h.requests.pop()?.({ messages: [], activeTurnId: null });
  await deleting;

  const chat = h.render();
  assert.equal(chat.selectedThreadId, 'new-thread', '應自動切換至新建立的活躍對話而非已歸檔對話');
});
