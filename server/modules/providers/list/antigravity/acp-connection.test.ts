import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { AcpConnection, AcpRequestError } from './acp-connection.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.emit('exit', null, 'SIGTERM'); return true; };
  const written: any[] = [];
  child.stdin.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) written.push(JSON.parse(l)); });
  return { child, written };
}

const tick = () => new Promise((r) => setImmediate(r));

test('請求與回應配對，回應可被切成多段', async () => {
  const { child, written } = fakeChild();
  const conn = new AcpConnection(child as never);
  const result = conn.request('initialize', { protocolVersion: 1 });
  await tick();
  assert.equal(written[0].method, 'initialize');
  const line = JSON.stringify({ jsonrpc: '2.0', id: written[0].id, result: { protocolVersion: 1 } });
  child.stdout.write(line.slice(0, 10));
  child.stdout.write(`${line.slice(10)}\n`);
  assert.deepEqual(await result, { protocolVersion: 1 });
});

test('agent 的請求（字串 id）交給 onRequest 並回覆；通知交給 onNotification', async () => {
  const { child, written } = fakeChild();
  const notes: string[] = [];
  new AcpConnection(child as never, {
    onNotification: (method) => notes.push(method),
    onRequest: async (method) => (method === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: 'allow' } } : null),
  });
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} })}\n`);
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'session/request_permission', params: {} })}\n`);
  await tick(); await tick();
  assert.deepEqual(notes, ['session/update']);
  assert.deepEqual(written.at(-1), { jsonrpc: '2.0', id: '1', result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
});

test('錯誤回應以 AcpRequestError 拒絕', async () => {
  const { child, written } = fakeChild();
  const conn = new AcpConnection(child as never);
  const result = conn.request('session/new', {});
  await tick();
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: written[0].id, error: { code: -32000, message: 'Authentication required' } })}\n`);
  await assert.rejects(result, (error: unknown) => error instanceof AcpRequestError && error.code === -32000);
});

test('行程意外退出時未完成的請求全部拒絕，並附 stderr', async () => {
  const { child } = fakeChild();
  let exited = false;
  const conn = new AcpConnection(child as never, { onExit: () => { exited = true; } });
  const a = conn.request('session/prompt', {}, 0);
  child.stderr.write('panic: boom');
  await tick();
  child.emit('exit', 2, null);
  await assert.rejects(a, /exited \(code 2\): panic: boom/);
  assert.equal(exited, true);
  await assert.rejects(conn.request('x', {}), /closed/);
});

test('請求逾時', async (t) => {
  // 真實執行由子行程維持事件迴圈；測試替身需自行維持到逾時完成。
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const { child } = fakeChild();
  const conn = new AcpConnection(child as never, {}, 20);
  await assert.rejects(conn.request('slow', {}), /timed out/);
});
