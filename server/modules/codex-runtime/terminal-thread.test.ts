import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareCodexTerminalThread } from './terminal-thread.js';

test('terminal preflight only reads an existing thread and never resumes it', async () => {
  const calls: unknown[] = [];
  const rpc = { async request(method: string, params: Record<string, unknown>) {
    calls.push({ method, params });
    return { thread: { id: 'root', cwd: process.cwd(), parentThreadId: null } };
  } };
  assert.equal(await prepareCodexTerminalThread(rpc, 'root', process.cwd()), 'root');
  assert.deepEqual(calls, [{ method: 'thread/read', params: { threadId: 'root' } }]);
});

test('child threads give an actionable parent ID without silently resuming the parent', async () => {
  const calls: string[] = [];
  const rpc = { async request(method: string) { calls.push(method); return { thread: { id: 'child', parentThreadId: 'parent' } }; } };
  await assert.rejects(prepareCodexTerminalThread(rpc, 'child', process.cwd()), /parent conversation \(parent\)/);
  assert.deepEqual(calls, ['thread/read']);
});

test('failed reads never fall back to new sessions, and mismatched IDs are rejected', async () => {
  const calls: string[] = [];
  await assert.rejects(prepareCodexTerminalThread({ async request(method) {
    calls.push(method); throw new Error('no rollout found');
  } }, 'missing', process.cwd()), /no rollout/);
  assert.deepEqual(calls, ['thread/read']);
  await assert.rejects(prepareCodexTerminalThread({ async request() { return { thread: { id: 'wrong' } }; } }, 'root', process.cwd()), /different thread/);
});

test('only a genuinely new terminal creates a thread', async () => {
  const calls: string[] = [];
  assert.equal(await prepareCodexTerminalThread({ async request(method) {
    calls.push(method); return { thread: { id: 'new' } };
  } }, null, process.cwd()), 'new');
  assert.deepEqual(calls, ['thread/start']);
});
