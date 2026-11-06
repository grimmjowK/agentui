import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { queryCodex, resolveCodexApproval } from './openai-codex.js';

// 假的 codex app-server：turn 開始後發出 item/permissions/requestApproval，
// 把客戶端的回覆寫進檔案，再正常結束這一輪
test('額外權限請求經 queryCodex 自動拒絕並提示，這一輪照常完成而不是失敗', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-perm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const replyFile = path.join(root, 'reply.json');
  const executable = path.join(root, 'codex');
  fs.writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') out({ id: msg.id, result: {} });
  else if (msg.method === 'thread/start') out({ id: msg.id, result: { thread: { id: 'thread-perm', cwd: process.cwd() } } });
  else if (msg.method === 'turn/start') {
    out({ id: msg.id, result: { turn: { id: 'turn-perm' } } });
    out({ id: 'perm-1', method: 'item/permissions/requestApproval', params: {
      threadId: 'thread-perm', turnId: 'turn-perm', itemId: 'i1', environmentId: null, startedAtMs: 0,
      cwd: process.cwd(), reason: 'need network', permissions: { network: { enabled: true } } } });
  } else if (msg.id === 'perm-1') {
    require('node:fs').writeFileSync(${JSON.stringify(replyFile)}, JSON.stringify(msg));
    out({ method: 'turn/completed', params: { threadId: 'thread-perm', turn: { id: 'turn-perm', status: 'completed', items: [] } } });
  }
});
`, { mode: 0o755 });

  const previous = { CODEX_CLI_PATH: process.env.CODEX_CLI_PATH, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CODEX_CLI_PATH = executable;
  process.env.CODEX_HOME = root;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const messages: any[] = [];
  const writer = { isWebSocketWriter: true, userId: 7, send: (m: any) => messages.push(m), setSessionId: () => {} };
  await queryCodex('hi', { cwd: root, model: 'gpt-test' }, writer as any);

  assert.deepEqual(JSON.parse(fs.readFileSync(replyFile, 'utf8')).result, { permissions: {}, scope: 'turn' });
  assert.ok(messages.some((m) => m.kind === 'task_notification' && m.status === 'warning' && m.summary.includes('need network')));
  assert.equal(messages.filter((m) => m.kind === 'error').length, 0);
  assert.equal(messages.at(-1)?.kind, 'complete');
});

// 假的 codex app-server：turn 開始後發出 item/permissions/requestApproval，
// 把客戶端的回覆寫進檔案，再正常結束這一輪
test('MCP elicitation with nullable turnId completes through queryCodex', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-perm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const replyFile = path.join(root, 'reply.json');
  const executable = path.join(root, 'codex');
  fs.writeFileSync(executable, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') out({ id: msg.id, result: {} });
  else if (msg.method === 'thread/start') out({ id: msg.id, result: { thread: { id: 'thread-perm', cwd: process.cwd() } } });
  else if (msg.method === 'turn/start') {
    out({ id: msg.id, result: { turn: { id: 'turn-perm' } } });
    out({ id: 'perm-1', method: 'mcpServer/elicitation/request', params: {
      threadId: 'thread-perm', turnId: null, serverName: 'cua_repl', mode: 'form', _meta: null,
      message: 'Allow Chrome?', requestedSchema: { type: 'object', properties: {} } } });
  } else if (msg.id === 'perm-1') {
    require('node:fs').writeFileSync(${JSON.stringify(replyFile)}, JSON.stringify(msg));
    out({ method: 'turn/completed', params: { threadId: 'thread-perm', turn: { id: 'turn-perm', status: 'completed', items: [] } } });
  }
});
`, { mode: 0o755 });

  const previous = { CODEX_CLI_PATH: process.env.CODEX_CLI_PATH, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CODEX_CLI_PATH = executable;
  process.env.CODEX_HOME = root;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const messages: any[] = [];
  const writer = { isWebSocketWriter: true, userId: 7, send: (m: any) => {
    messages.push(m);
    if (m.kind === 'permission_request') {
      assert.equal(resolveCodexApproval(m.requestId, 7, 'thread-perm', { action: 'accept', content: {} }), true);
    }
  }, setSessionId: () => {} };
  await queryCodex('hi', { cwd: root, model: 'gpt-test' }, writer as any);

  assert.deepEqual(JSON.parse(fs.readFileSync(replyFile, 'utf8')).result, { action: 'accept', content: {}, _meta: null });
  assert.ok(messages.some((m) => m.kind === 'permission_request' && m.toolName === 'mcpServer/elicitation/request'));
  assert.equal(messages.filter((m) => m.kind === 'error').length, 0);
  assert.equal(messages.at(-1)?.kind, 'complete');
});
