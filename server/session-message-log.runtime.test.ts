import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';

const canMock = typeof mock.module === 'function';
if (canMock) {
  mock.module('@anthropic-ai/claude-agent-sdk', {
    namedExports: {
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'claude-runtime-e2e' };
          yield {
            type: 'assistant',
            session_id: 'claude-runtime-e2e',
            message: {
              id: 'claude-message-e2e',
              model: 'claude-test',
              role: 'assistant',
              content: [{ type: 'text', text: 'Claude answer' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield { type: 'result', session_id: 'claude-runtime-e2e', result: 'Claude answer' };
        },
        interrupt: async () => {},
      }),
    },
  });
}

const { queryClaudeSDK } = await import('./claude-sdk.js');
const { queryCodex } = await import('./openai-codex.js');
const { spawnAntigravity } = await import('./antigravity-cli.js');
const { closeConnection } = await import('./modules/database/connection.js');
const { initializeDatabase } = await import('./modules/database/init-db.js');
const { sessionMessagesDb } = await import('./modules/database/repositories/session-messages.db.js');
const { LoggingWriter, getLoggingWriterForSession } = await import('./modules/websocket/services/logging-writer.service.js');

class CaptureWriter {
  readonly messages: any[] = [];
  ws = { readyState: 1 };
  sessionId: string | null = null;
  userId = 7;
  isWebSocketWriter = false;

  send(message: unknown): void {
    this.messages.push(message);
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  updateWebSocket(ws: unknown): void {
    this.ws = ws as { readyState: number };
  }
}

let root = '';
let previous: Record<string, string | undefined> = {};

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'message-log-runtime-'));
  previous = {
    DATABASE_PATH: process.env.DATABASE_PATH,
    CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
    CODEX_HOME: process.env.CODEX_HOME,
    ANTIGRAVITY_CLI_PATH: process.env.ANTIGRAVITY_CLI_PATH,
    ANTIGRAVITY_HOME: process.env.ANTIGRAVITY_HOME,
  };
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'app.db');
  await initializeDatabase();
});

after(async () => {
  closeConnection();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const { rm } = await import('node:fs/promises');
  await rm(root, { recursive: true, force: true });
});

function assertPersistentRowsHaveSeq(messages: any[]): void {
  const persistentKinds = new Set(['text', 'thinking', 'tool_use', 'error']);
  for (const message of messages) {
    const persistent = persistentKinds.has(message.kind)
      || message.isInterrupted
      || message.isCompactBoundary
      || (message.kind === 'task_notification' && ['warning', 'error'].includes(message.status));
    if (persistent) {
      assert.equal(typeof message.seq, 'number', `${message.kind} ${message.id} lacks seq`);
    }
  }
}

function clientSequence(messages: any[]): Array<[string, number]> {
  const byId = new Map<string, any>();
  for (const message of messages) {
    if (typeof message.seq === 'number') byId.set(message.id, message);
  }
  return [...byId.values()]
    .sort((left, right) => left.seq - right.seq)
    .map((message) => [message.id, message.seq]);
}

function assertClientMatchesJournal(sessionId: string, messages: any[]): void {
  const journal = sessionMessagesDb.list(sessionId).messages
    .map((message) => [message.id, message.seq] as [string, number]);
  assert.deepEqual(clientSequence(messages), journal);
}

test('Claude runtime writes durable rows through LoggingWriter', { skip: !canMock && 'needs module mocks' }, async () => {
  const capture = new CaptureWriter();
  const writer = new LoggingWriter(capture, { provider: 'claude', userId: 7 });
  writer.recordUserMessage({
    clientId: '11111111-1111-4111-8111-111111111111',
    content: 'hello Claude',
    provider: 'claude',
  });
  await queryClaudeSDK('hello Claude', { cwd: root }, writer);
  writer.finish();

  assertPersistentRowsHaveSeq(capture.messages);
  assertClientMatchesJournal('claude-runtime-e2e', capture.messages);
  assert.ok(sessionMessagesDb.list('claude-runtime-e2e').messages.some((message) => message.role === 'assistant'));
  assert.equal(getLoggingWriterForSession('claude-runtime-e2e'), null);
});

test('Codex runtime emits objects through LoggingWriter and persists missing-seq paths', async () => {
  const executable = path.join(root, 'codex');
  await writeFile(executable, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') out({ id: msg.id, result: {} });
  else if (msg.method === 'thread/start') out({ id: msg.id, result: { thread: { id: 'codex-runtime-e2e', cwd: process.cwd() } } });
  else if (msg.method === 'turn/start') {
    out({ id: msg.id, result: { turn: { id: 'turn-e2e' } } });
    out({ id: 'perm-e2e', method: 'item/permissions/requestApproval', params: {
      threadId: 'codex-runtime-e2e', turnId: 'turn-e2e', itemId: 'i1', environmentId: null, startedAtMs: 0,
      cwd: process.cwd(), reason: 'need network', permissions: { network: { enabled: true } } } });
  } else if (msg.id === 'perm-e2e') {
    out({ method: 'turn/completed', params: { threadId: 'codex-runtime-e2e', turn: { id: 'turn-e2e', status: 'completed', items: [] } } });
  }
});
`, 'utf8');
  await chmod(executable, 0o755);
  process.env.CODEX_CLI_PATH = executable;
  process.env.CODEX_HOME = root;

  const capture = new CaptureWriter();
  const writer = new LoggingWriter(capture, { provider: 'codex', userId: 7 });
  writer.recordUserMessage({
    clientId: '22222222-2222-4222-8222-222222222222',
    content: 'hello Codex',
    provider: 'codex',
  });
  await queryCodex('hello Codex', { cwd: root, model: 'gpt-test' }, writer);
  writer.finish();

  assertPersistentRowsHaveSeq(capture.messages);
  assertClientMatchesJournal('codex-runtime-e2e', capture.messages);
  assert.ok(capture.messages.some((message) => message.kind === 'task_notification' && message.seq));
  assert.ok(sessionMessagesDb.list('codex-runtime-e2e').messages.some((message) => message.kind === 'task_notification'));
});

test('Antigravity runtime writes tool/text rows through LoggingWriter', async () => {
  const executable = path.join(root, 'agy');
  await writeFile(executable, `#!${process.execPath}
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const id = 'antigravity-runtime-e2e';
out({ event: 'init', conversation_id: id, init: { cwd: process.cwd() } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'pwd' } } } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'pwd' }, output: '/workspace' } } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'Antigravity answer' } });
out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'Antigravity answer' } });
`, 'utf8');
  await chmod(executable, 0o755);
  process.env.ANTIGRAVITY_CLI_PATH = executable;
  process.env.ANTIGRAVITY_HOME = root;

  const capture = new CaptureWriter();
  const writer = new LoggingWriter(capture, { provider: 'antigravity', userId: 7 });
  writer.recordUserMessage({
    clientId: '33333333-3333-4333-8333-333333333333',
    content: 'hello Antigravity',
    provider: 'antigravity',
  });
  await spawnAntigravity('hello Antigravity', { cwd: root }, writer);
  writer.finish();

  assertPersistentRowsHaveSeq(capture.messages);
  assertClientMatchesJournal('antigravity-runtime-e2e', capture.messages);
  const rows = sessionMessagesDb.list('antigravity-runtime-e2e').messages;
  assert.ok(rows.some((message) => message.kind === 'tool_use' && message.toolResult));
  assert.ok(rows.some((message) => message.kind === 'text' && message.role === 'assistant'));
});
