/**
 * ACP 執行層測試：以假的 `agy acp`（node 腳本）重播 agy 1.5.11 實測的協議形狀。
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, sessionMessagesDb } from './modules/database/index.js';
import { antigravityApprovals } from './modules/providers/index.js';
import { LoggingWriter } from './modules/websocket/services/logging-writer.service.js';

import {
  abortAntigravitySession,
  getActiveAntigravitySessions,
  linkLiveIdsToTranscript,
  spawnAntigravity,
  steerAntigravitySession,
} from './antigravity-cli.js';

// 假 agent：依 prompt 文字決定劇本，記錄收到的請求到 calls.jsonl
const FAKE_AGENT = `
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.ANTIGRAVITY_HOME;
const log = (m) => fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify(m) + '\\n');
log({ argv: process.argv.slice(2), cwd: process.cwd() });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const update = (sessionId, u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const prompts = new Map();
let sessionId = null;
let permId = 0;
const waiters = new Map();
const tool = (status, extra = {}) => ({ sessionUpdate: status === 'in_progress' && !extra.update ? 'tool_call' : 'tool_call_update', toolCallId: 'call_1', name: 'run_command', args: { CommandLine: 'ls -la' }, status, ...extra });
const transcript = (entries) => {
  const dir = path.join(home, 'brain', sessionId, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  for (const e of entries) fs.appendFileSync(path.join(dir, 'transcript.jsonl'), JSON.stringify(e) + '\\n');
};
const finishPrompt = (id, stopReason = 'end_turn') => out({ jsonrpc: '2.0', id, result: { stopReason } });
async function runPrompt(id, text) {
  log({ prompt: text });
  if (text === 'auth') return out({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Authentication required' } });
  if (text === 'crash') { process.stderr.write('fatal: boom'); process.exit(3); }
  if (text.startsWith('tool')) {
    update(sessionId, tool('in_progress'));
    update(sessionId, tool('pending', { update: true }));
    const pid = String(++permId);
    out({ jsonrpc: '2.0', id: pid, method: 'session/request_permission', params: { sessionId, toolCall: tool('pending'), options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } });
    const answer = await new Promise((r) => waiters.set(pid, r));
    log({ permission: answer });
    if (answer.outcome.outcome === 'cancelled') { update(sessionId, tool('failed', { update: true, content: [] })); return finishPrompt(id, 'cancelled'); }
    if (answer.outcome.optionId === 'deny') { update(sessionId, tool('failed', { update: true, content: [{ type: 'content', content: { type: 'text', text: '' } }] })); return finishPrompt(id); }
    update(sessionId, tool('completed', { update: true, content: [{ type: 'content', content: { type: 'text', text: 'Command exited with code 0.\\n\\nCommand output:\\nfile' } }] }));
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one file' } });
    transcript([
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>' + text + '</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls -la"' } }] },
      { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Command exited with code 0.' },
      { step_index: 3, type: 'PLANNER_RESPONSE', content: 'one file' },
    ]);
    return finishPrompt(id);
  }
  if (text === 'slow') {
    prompts.set('slow', id);
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working ' } });
    return; // 等插話或取消
  }
  if (prompts.has('slow')) {
    // 插話：第一個 prompt 立刻以 end_turn 返回，最後一則回覆遵循插話
    finishPrompt(prompts.get('slow'));
    prompts.delete('slow');
    setTimeout(() => {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done ' + text } });
      finishPrompt(id);
    }, 30);
    return;
  }
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer:' + text } });
  transcript([
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>' + text + '</USER_REQUEST>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', content: 'answer:' + text },
  ]);
  finishPrompt(id);
}
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method) log({ method: m.method, params: m.params });
  if (m.id !== undefined && !m.method) { waiters.get(String(m.id))?.(m.result); waiters.delete(String(m.id)); return; }
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { version: 'fake' } } });
  if (m.method === 'session/new') { sessionId = 'acp-' + Date.now(); return out({ jsonrpc: '2.0', id: m.id, result: { sessionId } }); }
  if (m.method === 'session/resume') { sessionId = m.params.sessionId; return out({ jsonrpc: '2.0', id: m.id, result: {} }); }
  if (m.method === 'session/set_mode' || m.method === 'session/set_model') return out({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'session/prompt') return void runPrompt(m.id, m.params.prompt[0].text);
  if (m.method === 'session/cancel') {
    for (const [pid, w] of waiters) { w({ outcome: { outcome: 'cancelled' } }); waiters.delete(pid); }
    if (prompts.has('slow')) { finishPrompt(prompts.get('slow'), 'cancelled'); prompts.delete('slow'); }
  }
});
`;

let root = '';
const previous: Record<string, string | undefined> = {};

test.before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'agy-acp-'));
  for (const key of ['DATABASE_PATH', 'ANTIGRAVITY_HOME', 'ANTIGRAVITY_CLI_PATH', 'ANTIGRAVITY_NATIVE_TITLE_RESYNC_DELAY_MS']) previous[key] = process.env[key];
  const executable = path.join(root, 'agy');
  await writeFile(executable, `#!${process.execPath}\n${FAKE_AGENT}`, 'utf8');
  await chmod(executable, 0o755);
  await mkdir(path.join(root, 'workspace'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'app.db');
  process.env.ANTIGRAVITY_HOME = root;
  process.env.ANTIGRAVITY_CLI_PATH = executable;
  process.env.ANTIGRAVITY_NATIVE_TITLE_RESYNC_DELAY_MS = '600000';
  await initializeDatabase();
});

test.after(async () => {
  closeConnection();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function calls(): Promise<any[]> {
  return (await readFile(path.join(root, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function capture(userId: number | null = 7) {
  const messages: any[] = [];
  const writer = { isWebSocketWriter: true, userId, send: (m: any) => messages.push(m), setSessionId() {} };
  return { messages, writer };
}

const cwd = () => path.join(root, 'workspace');
const until = async (check: () => boolean) => { while (!check()) await new Promise((r) => setTimeout(r, 5)); };

test('新會話：session/new、串流文字、一次 complete、登記會話', async () => {
  const { messages, writer } = capture();
  await spawnAntigravity('hello', { cwd: cwd(), model: 'gemini-4-argon-low', permissionMode: 'acceptEdits' }, writer);
  const created = messages.find((m) => m.kind === 'session_created');
  assert.ok(created.sessionId.startsWith('acp-'));
  assert.equal(sessionsDb.getSessionById(created.sessionId)?.project_path, cwd());
  assert.deepEqual(messages.filter((m) => m.kind === 'stream_delta').map((m) => m.content), ['answer:hello']);
  assert.equal(messages.find((m) => m.kind === 'text').content, 'answer:hello');
  assert.equal(messages.filter((m) => m.kind === 'complete').length, 1);
  const log = await calls();
  assert.ok(log.some((c) => c.method === 'session/set_mode' && c.params.modeId === 'accept-edits'));
  assert.ok(log.some((c) => c.method === 'session/set_model' && c.params.modelId === 'gemini-4-argon-low'));
  assert.deepEqual(getActiveAntigravitySessions(), []);
});

test('bypassPermissions 以 --dangerously-skip-permissions 啟動', async () => {
  const { writer } = capture();
  await spawnAntigravity('bypass', { cwd: cwd(), permissionMode: 'bypassPermissions' }, writer);
  const argvs = (await calls()).filter((c) => c.argv).map((c) => c.argv);
  assert.deepEqual(argvs.at(-1), ['acp', '--dangerously-skip-permissions']);
});

test('審批：允許後工具結果與回覆正常；即時 id 對上 transcript 歷史 id', async () => {
  const { messages, writer } = capture();
  const run = spawnAntigravity('tool allow', { cwd: cwd() }, writer);
  await until(() => messages.some((m) => m.kind === 'permission_request'));
  const request = messages.find((m) => m.kind === 'permission_request');
  assert.equal(request.toolName, 'Bash');
  assert.deepEqual(request.context.decisions, ['allow', 'deny']);
  assert.equal(antigravityApprovals.decide(request.requestId, 8, 'allow'), false, '非發起者');
  assert.equal(antigravityApprovals.decide(request.requestId, 7, 'allow'), true);
  await run;
  const result = messages.find((m) => m.kind === 'tool_result');
  assert.equal(result.isError, false);
  assert.match(result.content, /^Command exited with code 0/);
  assert.equal(messages.find((m) => m.kind === 'text').content, 'one file');
});

test('審批：拒絕後工具顯示錯誤，這一輪正常結束', async () => {
  const { messages, writer } = capture();
  const run = spawnAntigravity('tool deny', { cwd: cwd() }, writer);
  await until(() => messages.some((m) => m.kind === 'permission_request'));
  antigravityApprovals.decide(messages.find((m) => m.kind === 'permission_request').requestId, 7, 'deny');
  await run;
  assert.equal(messages.find((m) => m.kind === 'tool_result').isError, true);
  assert.equal(messages.filter((m) => m.kind === 'complete' && m.success).length, 1);
});

test('審批中中斷：未決審批回覆已取消、送出 permission_cancelled、一次中斷完成', async () => {
  const { messages, writer } = capture();
  const run = spawnAntigravity('tool cancel', { cwd: cwd() }, writer);
  await until(() => messages.some((m) => m.kind === 'permission_request'));
  const sessionId = messages.find((m) => m.kind === 'session_created').sessionId;
  assert.equal(steerAntigravitySession(sessionId, 7, 'more').reason, 'waiting_approval');
  assert.equal(abortAntigravitySession(sessionId), true);
  await run;
  assert.equal(messages.filter((m) => m.kind === 'permission_cancelled' && m.reason === 'aborted').length, 1);
  assert.equal(messages.filter((m) => m.kind === 'complete').length, 1);
  assert.equal(messages.find((m) => m.kind === 'complete').aborted, true);
  assert.ok((await calls()).some((c) => c.method === 'session/cancel'));
  assert.equal(antigravityApprovals.list(7).length, 0);
});

test('插話：第一個 prompt 提前返回時不收尾，全部返回後只送一次 complete', async () => {
  const { messages, writer } = capture();
  const run = spawnAntigravity('slow', { cwd: cwd() }, writer);
  await until(() => messages.some((m) => m.kind === 'stream_delta'));
  const sessionId = messages.find((m) => m.kind === 'session_created').sessionId;
  assert.equal(steerAntigravitySession(sessionId, 8, 'x').reason, 'not_owner');
  assert.deepEqual(steerAntigravitySession(sessionId, 7, 'PINEAPPLE'), { ok: true });
  await run;
  assert.equal(messages.filter((m) => m.kind === 'complete').length, 1);
  assert.match(messages.filter((m) => m.kind === 'text').map((m) => m.content).join(''), /done PINEAPPLE/);
  assert.equal(steerAntigravitySession(sessionId, 7, 'late').reason, 'not_running');
});

test('續接：session/resume 帶原會話 id', async () => {
  const { messages, writer } = capture();
  await spawnAntigravity('first', { cwd: cwd() }, writer);
  const sessionId = messages.find((m) => m.kind === 'session_created').sessionId;
  const second = capture();
  await spawnAntigravity('second', { cwd: cwd(), sessionId }, second.writer);
  assert.ok((await calls()).some((c) => c.method === 'session/resume' && c.params.sessionId === sessionId));
  assert.equal(second.messages.some((m) => m.kind === 'session_created'), false);
  assert.equal(second.messages.filter((m) => m.kind === 'complete').length, 1);
});

test('未登入：明確錯誤並拒絕', async () => {
  const { messages, writer } = capture();
  await assert.rejects(spawnAntigravity('auth', { cwd: cwd() }, writer), /尚未登入/);
  assert.equal(messages.filter((m) => m.kind === 'error').length, 1);
  assert.deepEqual(getActiveAntigravitySessions(), []);
});

test('行程意外退出：錯誤帶 stderr，清除執行中登記', async () => {
  const { messages, writer } = capture();
  await assert.rejects(spawnAntigravity('crash', { cwd: cwd() }, writer), /fatal: boom|exited/);
  assert.equal(messages.filter((m) => m.kind === 'error').length, 1);
  assert.deepEqual(getActiveAntigravitySessions(), []);
});

test('LoggingWriter：即時 tool/text 寫入日誌，並在結束後對上 transcript 的歷史 id', async () => {
  const capture2 = { messages: [] as any[], ws: null as unknown, send(m: any) { this.messages.push(m); }, setSessionId() {}, userId: 7 };
  const writer = new LoggingWriter(capture2, { provider: 'antigravity', userId: 7 });
  const run = spawnAntigravity('tool logged', { cwd: cwd() }, writer);
  await until(() => capture2.messages.some((m) => m.kind === 'permission_request'));
  antigravityApprovals.decide(capture2.messages.find((m) => m.kind === 'permission_request').requestId, 7, 'allow');
  await run;
  writer.finish();
  const sessionId = capture2.messages.find((m) => m.kind === 'session_created').sessionId;
  const rows = sessionMessagesDb.listAll(sessionId);
  const toolRow = rows.find((r) => r.payload.kind === 'tool_use');
  const textRow = rows.find((r) => r.payload.kind === 'text' && r.payload.role === 'assistant');
  assert.ok(toolRow?.providerIds.includes('agy_tool_2'), JSON.stringify(toolRow?.providerIds));
  assert.ok(textRow?.providerIds.includes(`agy_${sessionId}_step_3`), JSON.stringify(textRow?.providerIds));
});

test('linkLiveIdsToTranscript：優先讀 transcript_full.jsonl，且插話合併多筆 PLANNER_RESPONSE 時一併綁定所有歷史文字 id', async () => {
  const sid = 'acp-link-test';
  const dir = path.join(root, 'brain', sid, '.system_generated', 'logs');
  await mkdir(dir, { recursive: true });
  const compactPath = path.join(dir, 'transcript.jsonl');
  const fullPath = path.join(dir, 'transcript_full.jsonl');

  await writeFile(compactPath, `${JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'hi' })}\n`, 'utf8');
  await writeFile(
    fullPath,
    [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'hi' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'part A ' }),
      JSON.stringify({ step_index: 2, type: 'USER_INPUT', content: 'steer' }),
      JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', content: 'part B' }),
    ].join('\n') + '\n',
    'utf8',
  );

  const writer = new LoggingWriter({ send() {}, setSessionId() {}, userId: 7 }, { initialSessionId: sid, provider: 'antigravity', userId: 7 });
  writer.send({ kind: 'text', role: 'assistant', id: 'live-merged-1', content: 'part A part B', sessionId: sid });
  writer.finish();

  linkLiveIdsToTranscript(sid, compactPath, -1, [], ['live-merged-1']);
  const textRow = sessionMessagesDb.listAll(sid).find((r) => r.id === 'live-merged-1');
  assert.deepEqual(textRow?.providerIds, [`agy_${sid}_step_1`, `agy_${sid}_step_3`]);
});
