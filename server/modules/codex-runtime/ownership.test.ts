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

test('diagnose is read-only and reports identity verdicts and age', (t) => {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-owner-diag-'));
  t.after(() => fs.rmSync(configRoot, { recursive: true, force: true }));
  const manager = new CodexOwnership();
  assert.equal(manager.diagnose(configRoot, 'missing'), null);

  // 当前进程持有：server 身份应为 confirmed-alive（PID 存活且签名一致）。
  const lease = manager.acquire({ configRoot, threadId: 'thread', projectPath: configRoot, userId: 1, owner: 'chat' });
  const diagnosis = manager.diagnose(configRoot, 'thread');
  assert.ok(diagnosis);
  assert.equal(diagnosis!.owner, 'chat');
  assert.equal(diagnosis!.userId, 1);
  assert.equal(diagnosis!.server, 'confirmed-alive');
  assert.ok(diagnosis!.ageMs !== null && diagnosis!.ageMs >= 0);
  // 诊断不改变锁：仍被持有。
  assert.throws(() => manager.acquire({ configRoot, threadId: 'thread', projectPath: configRoot, userId: 2, owner: 'chat' }), /another user/);
  manager.release(lease);
});

test('force-release refuses a live holder and releases a confirmed-exited one past the age threshold', (t) => {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-owner-force-'));
  t.after(() => fs.rmSync(configRoot, { recursive: true, force: true }));
  const manager = new CodexOwnership();
  const lease = manager.acquire({ configRoot, threadId: 'thread', projectPath: configRoot, userId: 1, owner: 'chat' });

  // 持有方（当前进程）仍存活 → 拒绝释放，即使 minAge=0。
  assert.equal(manager.forceRelease(configRoot, 'thread', 0), 'still-alive');

  // 把 owner.json 改写成一个已退出的 server PID（ESRCH），并把 claimedAt 提前。
  const ownerFile = path.join(lease.directory, 'owner.json');
  const record = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  record.serverPid = 2 ** 22; // 极大 PID，几乎不可能存在 → confirmed-exited
  delete record.pid; delete record.startedAt; // 无子进程 → child 为 unknown（不是 alive）
  record.claimedAt = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(ownerFile, JSON.stringify(record));

  // 锁龄够、无存活端 → 释放成功。
  assert.equal(manager.forceRelease(configRoot, 'thread', 600_000), 'released');
  assert.equal(manager.diagnose(configRoot, 'thread'), null);
});
