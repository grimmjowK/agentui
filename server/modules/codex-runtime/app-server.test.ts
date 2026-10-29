import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { CodexAppServer } from './app-server.js';

function fake(t: { after: (fn: () => void) => void }, body: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rpc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'codex with spaces;literal');
  fs.writeFileSync(executable, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return new CodexAppServer(executable, root);
}

test('stdio handles fragmented lines, interleaved server requests, unknown notifications and stderr', async (t) => {
  const rpc = fake(t, `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', line => {
      const msg = JSON.parse(line);
      if (!msg.method || msg.id === undefined) return;
      process.stderr.write('diagnostic, not JSON\\n');
      process.stdout.write(JSON.stringify({ method: 'future/notification', params: {} }) + '\\n');
      process.stdout.write(JSON.stringify({ id: 'approval-0', method: 'item/fileChange/requestApproval', params: {} }) + '\\n');
      const response = JSON.stringify({ id: msg.id, result: { ok: true } }) + '\\n';
      process.stdout.write(response.slice(0, 5));
      setTimeout(() => process.stdout.write(response.slice(5)), 10);
    });
  `);
  const requests: unknown[] = []; const notifications: unknown[] = []; const diagnostics: unknown[] = [];
  rpc.on('request', (message) => { requests.push(message.id); rpc.send({ id: message.id, result: { decision: 'decline' } }); });
  rpc.on('notification', (message) => notifications.push(message.method));
  rpc.on('diagnostic', (message) => diagnostics.push(message));
  assert.deepEqual(await rpc.initialize(), { ok: true });
  assert.deepEqual(requests, ['approval-0']);
  assert.deepEqual(notifications, ['future/notification']);
  assert.ok(diagnostics.length);
  await rpc.close();
  assert.notEqual(rpc.child.exitCode, null);
});

test('malformed protocol fails pending calls and exits', async (t) => {
  const rpc = fake(t, `process.stdin.on('data', () => process.stdout.write('not-json\\n'));`);
  await assert.rejects(rpc.initialize(), /Invalid Codex/);
  await rpc.close();
  assert.notEqual(rpc.child.exitCode ?? rpc.child.signalCode, null);
});

test('DeepSeek uses the configured Codex catalog path', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'codex');
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stdin.resume();`, { mode: 0o755 });
  const configRoot = path.join(root, 'custom-codex-home');
  const rpc = new CodexAppServer(executable, root, configRoot, 'deepseek-flash');
  assert.ok(rpc.child.spawnargs.includes(`model_catalog_json=${path.join(configRoot, 'models.json')}`));
  await rpc.close();
});

test('request timeout and abrupt process exit reject callers', async (t) => {
  const rpc = fake(t, `process.stdin.resume();`);
  await assert.rejects(rpc.request('never/replies', {}, 30), /timed out/);
  const failure = once(rpc, 'failure');
  const request = rpc.request('pending');
  rpc.child.kill('SIGKILL');
  await assert.rejects(request, /exited/);
  await failure;
  await rpc.close();
});
