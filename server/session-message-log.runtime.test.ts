import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';

let claudeScenario: 'normal' | 'abort' | 'error' | 'compact' = 'normal';
const canMock = typeof mock.module === 'function';
if (canMock) {
  mock.module('@anthropic-ai/claude-agent-sdk', {
    namedExports: {
      query: () => ({
        async *[Symbol.asyncIterator]() {
          if (claudeScenario === 'error') {
            yield { type: 'system', subtype: 'init', session_id: 'claude-error-e2e' };
            throw new Error('Claude retry exhausted');
          }
          if (claudeScenario === 'abort') {
            yield { type: 'system', subtype: 'init', session_id: 'claude-abort-e2e' };
            yield {
              type: 'stream_event',
              session_id: 'claude-abort-e2e',
              event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial ' } },
            };
            return;
          }
          if (claudeScenario === 'compact') {
            yield { type: 'system', subtype: 'init', session_id: 'claude-compact-e2e' };
            yield {
              type: 'system',
              subtype: 'compact_boundary',
              uuid: 'compact-uuid-1',
              session_id: 'claude-compact-e2e',
              compact_metadata: { trigger: 'auto', pre_tokens: 50000 },
            };
            yield {
              type: 'assistant',
              session_id: 'claude-compact-e2e',
              message: {
                id: 'claude-after-compact',
                model: 'claude-test',
                role: 'assistant',
                content: [{ type: 'text', text: 'Compacted reply' }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            yield { type: 'result', session_id: 'claude-compact-e2e', result: 'Compacted reply' };
            return;
          }
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
const { reconcileSessionMessageLog } = await import('./modules/providers/services/session-message-reconciler.service.js');
const { LoggingWriter, getLoggingWriterForSession } = await import('./modules/websocket/services/logging-writer.service.js');
const { applyLogMessage, clearLogStreaming, replaceWithFetched } = await import('../shared/sessionMessageLogMerge.js');

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

function createEmptySlot() {
  return {
    serverMessages: [] as any[],
    realtimeMessages: [] as any[],
    merged: [] as any[],
    _lastServerRef: [] as any[],
    _lastRealtimeRef: [] as any[],
    status: 'idle' as const,
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    nextBeforeSeq: null,
    tokenUsage: null,
  };
}

function applyRealtimeStreamToStore(sessionId: string, messages: any[]) {
  const slot = createEmptySlot();
  let streamText = '';
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.kind === 'stream_delta') {
      streamText += typeof message.content === 'string' ? message.content : '';
      applyLogMessage(slot, {
        id: `__streaming_${sessionId}`,
        sessionId,
        timestamp: new Date().toISOString(),
        provider: message.provider || 'claude',
        kind: 'stream_delta',
        content: streamText,
      });
      continue;
    }
    if (message.kind === 'stream_end') {
      streamText = '';
      continue;
    }
    if (message.kind === 'complete' || message.kind === 'error') {
      streamText = '';
      clearLogStreaming(slot, sessionId);
      if (message.kind === 'error' && typeof message.seq === 'number') {
        applyLogMessage(slot, message);
      }
      continue;
    }
    if (typeof message.seq === 'number') {
      applyLogMessage(slot, message);
    }
  }
  return slot;
}

function assertClientMatchesJournal(
  sessionId: string,
  provider: 'claude' | 'codex' | 'antigravity',
  messages: any[],
  history: any[] = [],
): void {
  const liveSlot = applyRealtimeStreamToStore(sessionId, messages);
  const reconciled = reconcileSessionMessageLog({
    sessionId,
    provider,
    history,
    active: false,
  });
  const fetchedSlot = createEmptySlot();
  replaceWithFetched(fetchedSlot, reconciled);

  const liveSeq = liveSlot.merged.map((message) => [message.id, message.seq, message.kind]);
  const fetchedSeq = fetchedSlot.merged.map((message) => [message.id, message.seq, message.kind]);
  if (JSON.stringify(liveSeq) !== JSON.stringify(fetchedSeq)) {
    const mismatchIndex = liveSeq.findIndex(
      (item, index) => JSON.stringify(item) !== JSON.stringify(fetchedSeq[index]),
    );
    assert.fail(
      `First mismatch at index ${mismatchIndex}: live=${JSON.stringify(liveSeq[mismatchIndex])} vs fetched=${JSON.stringify(fetchedSeq[mismatchIndex])}`,
    );
  }
}

test('Claude runtime writes durable rows through LoggingWriter', { skip: !canMock && 'needs module mocks' }, async () => {
  claudeScenario = 'normal';
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
  assertClientMatchesJournal('claude-runtime-e2e', 'claude', capture.messages);
  assert.ok(sessionMessagesDb.list('claude-runtime-e2e').messages.some((message) => message.role === 'assistant'));
  assert.equal(getLoggingWriterForSession('claude-runtime-e2e'), null);
});

test('Claude runtime error, compact_boundary, image-only user message, and abort match between live store and reconciled fetch', { skip: !canMock && 'needs module mocks' }, async () => {
  claudeScenario = 'error';
  const errorCapture = new CaptureWriter();
  const errorWriter = new LoggingWriter(errorCapture, { provider: 'claude', userId: 7 });
  errorWriter.recordUserMessage({
    clientId: '44444444-4444-4444-8444-444444444444',
    content: '',
    images: [{ name: 'shot.png', data: 'data:image/png;base64,aGVsbG8=' }],
    provider: 'claude',
  });
  await queryClaudeSDK('', { cwd: root }, errorWriter);
  errorWriter.finish();
  assertPersistentRowsHaveSeq(errorCapture.messages);
  assertClientMatchesJournal('claude-error-e2e', 'claude', errorCapture.messages);
  assert.ok(sessionMessagesDb.list('claude-error-e2e').messages.some((m) => m.kind === 'error'));

  claudeScenario = 'compact';
  const compactCapture = new CaptureWriter();
  const compactWriter = new LoggingWriter(compactCapture, { provider: 'claude', userId: 7 });
  compactWriter.recordUserMessage({
    clientId: '55555555-5555-4555-8555-555555555555',
    content: 'compact me',
    provider: 'claude',
  });
  await queryClaudeSDK('compact me', { cwd: root }, compactWriter);
  compactWriter.finish();
  assertPersistentRowsHaveSeq(compactCapture.messages);
  assertClientMatchesJournal('claude-compact-e2e', 'claude', compactCapture.messages);
  assert.ok(sessionMessagesDb.list('claude-compact-e2e').messages.some((m) => m.isCompactBoundary));

  claudeScenario = 'abort';
  const abortCapture = new CaptureWriter();
  const abortWriter = new LoggingWriter(abortCapture, { provider: 'claude', userId: 7 });
  abortWriter.recordUserMessage({
    clientId: '66666666-6666-4666-8666-666666666666',
    content: 'abort me',
    provider: 'claude',
  });
  await queryClaudeSDK('abort me', { cwd: root }, abortWriter);
  abortWriter.send({
    kind: 'complete',
    provider: 'claude',
    sessionId: 'claude-abort-e2e',
    aborted: true,
    success: true,
  });
  abortWriter.finish();
  assertPersistentRowsHaveSeq(abortCapture.messages);
  assertClientMatchesJournal('claude-abort-e2e', 'claude', abortCapture.messages);
  assert.ok(sessionMessagesDb.list('claude-abort-e2e').messages.some((m) => m.isInterrupted));
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
  assertClientMatchesJournal('codex-runtime-e2e', 'codex', capture.messages);
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
  assertClientMatchesJournal('antigravity-runtime-e2e', 'antigravity', capture.messages);
  const rows = sessionMessagesDb.list('antigravity-runtime-e2e').messages;
  assert.ok(rows.some((message) => message.kind === 'tool_use' && message.toolResult));
  assert.ok(rows.some((message) => message.kind === 'text' && message.role === 'assistant'));
});

test('Codex and Antigravity abort, steer, mid-run read, and mid-stream reconnect match between live store and reconciled fetch', async () => {
  // 1. Codex interrupted turn + mid-turn steer + mid-run read + mid-stream reconnect
  const codexAbortExec = path.join(root, 'codex-abort');
  await writeFile(codexAbortExec, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') out({ id: msg.id, result: {} });
  else if (msg.method === 'thread/start') out({ id: msg.id, result: { thread: { id: 'codex-abort-e2e', cwd: process.cwd() } } });
  else if (msg.method === 'turn/start') {
    out({ id: msg.id, result: { turn: { id: 'turn-abort' } } });
    out({ method: 'item/agentMessage/delta', params: { threadId: 'codex-abort-e2e', turnId: 'turn-abort', itemId: 'msg-1', delta: 'half ' } });
    out({ method: 'turn/completed', params: { threadId: 'codex-abort-e2e', turn: { id: 'turn-abort', status: 'interrupted', items: [] } } });
  }
});
`, 'utf8');
  await chmod(codexAbortExec, 0o755);
  process.env.CODEX_CLI_PATH = codexAbortExec;
  process.env.CODEX_HOME = root;

  const codexCapture = new CaptureWriter();
  const codexWriter = new LoggingWriter(codexCapture, { provider: 'codex', userId: 7 });
  codexWriter.recordUserMessage({
    clientId: '77777777-7777-4777-8777-777777777777',
    content: 'start codex',
    provider: 'codex',
  });
  await queryCodex('start codex', { cwd: root, model: 'gpt-test' }, codexWriter);
  codexWriter.finish();
  assertPersistentRowsHaveSeq(codexCapture.messages);
  assertClientMatchesJournal('codex-abort-e2e', 'codex', codexCapture.messages);
  assert.ok(sessionMessagesDb.list('codex-abort-e2e').messages.some((m) => m.isInterrupted));

  // 2. Antigravity mid-stream reconnect + mid-run read + abort
  const agyAbortExec = path.join(root, 'agy-abort');
  await writeFile(agyAbortExec, `#!${process.execPath}
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const id = 'antigravity-abort-e2e';
out({ event: 'init', conversation_id: id, init: { cwd: process.cwd() } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'partial stream ' } });
process.exit(130);
`, 'utf8');
  await chmod(agyAbortExec, 0o755);
  process.env.ANTIGRAVITY_CLI_PATH = agyAbortExec;
  process.env.ANTIGRAVITY_HOME = root;

  const agyCapture = new CaptureWriter();
  const agyWriter = new LoggingWriter(agyCapture, { provider: 'antigravity', userId: 7 });
  agyWriter.recordUserMessage({
    clientId: '88888888-8888-4888-8888-888888888888',
    content: 'abort agy',
    provider: 'antigravity',
  });
  await assert.rejects(() => spawnAntigravity('abort agy', { cwd: root }, agyWriter));
  // Simulate abort-session sending complete(aborted: true) and mid-run active read before finish
  const midRunRead = reconcileSessionMessageLog({
    sessionId: 'antigravity-abort-e2e',
    provider: 'antigravity',
    history: [
      {
        id: 'unmatched-history-while-active',
        sessionId: 'antigravity-abort-e2e',
        timestamp: new Date().toISOString(),
        provider: 'antigravity',
        kind: 'text',
        role: 'assistant',
        content: 'should not be imported while active',
      },
    ],
  });
  assert.equal(midRunRead.some((m) => m.id === 'unmatched-history-while-active'), false);

  // Mid-stream reconnect replay check before complete
  const reconnectedCapture = new CaptureWriter();
  const reconnectedWriter = getLoggingWriterForSession('antigravity-abort-e2e');
  assert.equal(reconnectedWriter, agyWriter);
  reconnectedWriter?.updateWebSocket(reconnectedCapture.ws);
  agyWriter.send({
    kind: 'complete',
    provider: 'antigravity',
    sessionId: 'antigravity-abort-e2e',
    aborted: true,
    success: true,
  });
  agyWriter.finish();
  assertPersistentRowsHaveSeq(agyCapture.messages);
  assertClientMatchesJournal('antigravity-abort-e2e', 'antigravity', agyCapture.messages);
});

