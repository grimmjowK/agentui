import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { abortCursorSession, spawnCursor } from './cursor-cli.js';

// 假的 cursor-agent：normal 正常結束；abort 一直跑，收到 SIGTERM 時仍吐出 result 與 stderr 再退出
const bin = mkdtempSync(path.join(tmpdir(), 'cursor-fake-'));
writeFileSync(path.join(bin, 'cursor-agent'), `#!/usr/bin/env node
const mode = process.env.FAKE_CURSOR_MODE;
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: 'cursor-' + mode });
if (mode === 'normal') {
  emit({ type: 'result', subtype: 'success', result: 'done' });
  process.exit(0);
}
process.on('SIGTERM', () => {
  emit({ type: 'result', subtype: 'error', result: 'interrupted' });
  process.stderr.write('terminated by signal');
  setTimeout(() => process.exit(143), 20);
});
setInterval(() => {}, 1000);
`);
chmodSync(path.join(bin, 'cursor-agent'), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const run = (mode: string) => {
  process.env.FAKE_CURSOR_MODE = mode;
  const messages: any[] = [];
  const writer = { isWebSocketWriter: true, send: (m: any) => messages.push(m), setSessionId: () => {} };
  const done = spawnCursor('hi', { cwd: bin }, writer).catch(() => {});
  return { messages, done };
};
const terminals = (messages: any[]) => messages.filter((m) => m.kind === 'complete' || m.kind === 'error');

test('正常結束只送出一個 complete（result 已送，close 不重送）', async () => {
  const { messages, done } = run('normal');
  await done;
  assert.equal(terminals(messages).length, 1);
});

test('中斷後底層不再送出 complete/error（終止事件由 dispatcher 送）', async () => {
  const { messages, done } = run('abort');
  while (!messages.some((m) => m.kind === 'session_created')) await new Promise((r) => setTimeout(r, 20));
  assert.equal(abortCursorSession('cursor-abort'), true);
  await done;
  assert.deepEqual(terminals(messages), []);
});
