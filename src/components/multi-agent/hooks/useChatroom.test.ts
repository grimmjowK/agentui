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
    createThread: async () => ({ id: 'new-thread', title: '新對話' }),
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
