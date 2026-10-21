import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexOwnership } from './ownership.js';

test('claims exclude chat/terminal and users, survive restart, and release only the matching lease', (t) => {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-owner-'));
  t.after(() => fs.rmSync(configRoot, { recursive: true, force: true }));
  const manager = new CodexOwnership();
  const owner = { configRoot, threadId: 'thread', projectPath: configRoot, userId: 1, owner: 'chat' as const };
  const lease = manager.acquire(owner);
  assert.throws(() => manager.acquire({ ...owner, owner: 'terminal' }), /owned by chat/);
  assert.throws(() => manager.acquire({ ...owner, userId: 2 }), /another user/);
  assert.throws(() => new CodexOwnership().acquire(owner), /owned by chat/);
  manager.release({ ...lease });
  assert.throws(() => manager.acquire(owner), /owned by chat/);
  manager.release(lease);
  const terminal = manager.acquire({ ...owner, owner: 'terminal' });
  manager.release(terminal);
  const pending = manager.acquire({ ...owner, threadId: null });
  manager.bind(pending, 'thread');
  assert.throws(() => manager.acquire(owner), /owned by chat/);
  manager.release(pending);
});
