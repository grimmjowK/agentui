/** Codex chat runtime: app-server JSON-RPC, with explicit approval replies. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CodexAppServer } from './modules/codex-runtime/index.js';
import { codexOwnership } from './modules/codex-runtime/index.js';
import { codexApprovals } from './modules/codex-runtime/index.js';
import { getCodexRuntimeInfo } from './shared/codex-cli-path.js';
import { createNormalizedMessage } from './shared/utils.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';

const activeCodexSessions = new Map();
const pendingRuns = new Set();
function notifySafely(notify, payload) {
  try { notify(payload); } catch (error) { console.warn('Codex notification delivery failed:', error.message); }
}

export function mapPermissionModeToCodexOptions(mode) {
  if (mode === 'bypassPermissions') return { sandbox: 'danger-full-access', approvalPolicy: 'never' };
  if (mode === 'acceptEdits') return { sandbox: 'workspace-write', approvalPolicy: 'never' };
  return { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
}

function send(writer, message) {
  const normalized = createNormalizedMessage({ provider: 'codex', ...message });
  if (writer.isWebSocketWriter || writer.isSSEStreamWriter) writer.send(normalized);
  else if (writer.readyState === undefined || writer.readyState === 1) writer.send(JSON.stringify(normalized));
}

export async function queryCodex(command, options = {}, writer) {
  let threadId = options.sessionId || null;
  const state = {
    instanceId: randomUUID(), writer, userId: writer.userId ?? null,
    rpc: null, turnId: null, status: 'running', startedAt: new Date().toISOString(),
    interrupted: false, finished: false,
  };
  const emit = (message) => send(state.writer, { sessionId: threadId, ...message });
  let finish;
  let fail;
  const completion = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  // Failure can arrive during initialization, before completion is awaited.
  void completion.catch(() => {});
  let startupTimer;
  let interruptTimer;
  let lease;
  let terminalMessage;
  const items = new Map();
  const streamed = new Set();
  try {
    if (threadId && activeCodexSessions.has(threadId)) throw new Error('Codex session is already running');
    if (threadId) activeCodexSessions.set(threadId, state);
    pendingRuns.add(state);
    const runtime = getCodexRuntimeInfo();
    state.runtime = runtime;
    if (runtime.capabilities.status !== 'protocol-tested') {
      throw new Error(`Codex ${runtime.version} at ${runtime.executablePath} has not passed the app-server protocol baseline. See docs/codex-runtime-protocol.md; no exec fallback is used.`);
    }
    const cwd = options.cwd || options.projectPath || process.cwd();
    lease = codexOwnership.acquire({ configRoot: runtime.configRoot, threadId, projectPath: cwd, userId: state.userId, owner: 'chat' });
    const rpc = new CodexAppServer(runtime.executablePath, cwd, runtime.configRoot);
    codexOwnership.attach(lease, rpc.child.pid);
    state.rpc = rpc;
    rpc.on('failure', (error) => { if (!state.finished) fail(error); });
    rpc.on('request', (request) => {
      const params = request.params || {};
      const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'];
      if (!supported.includes(request.method) || state.userId === null || params.threadId !== threadId
        || (state.turnId && params.turnId !== state.turnId) || state.interrupted || state.finished) {
        rpc.send({ id: request.id, error: { code: -32601, message: 'Unsupported or invalid Codex approval request' } });
        fail(new Error(`Unsupported or invalid Codex request: ${request.method}`));
        return;
      }
      codexApprovals.add({
        userId: state.userId, threadId, turnId: params.turnId, instanceId: state.instanceId,
        request, item: items.get(params.itemId), notify: emit,
        reply: (result) => rpc.send({ id: request.id, result }),
      });
    });
    rpc.on('notification', ({ method, params = {} }) => {
      if (params.threadId && params.threadId !== threadId) return;
      if (state.finished) return;
      if (method === 'turn/started') state.turnId = params.turn.id;
      if (method === 'item/agentMessage/delta') {
        streamed.add(params.itemId);
        emit({ kind: 'stream_delta', content: params.delta });
      }
      if (method === 'item/started' || method === 'item/completed') {
        const item = params.item;
        if (!item) return;
        items.set(item.id, item);
        if (item.type === 'agentMessage' && method === 'item/completed') {
          if (streamed.has(item.id)) emit({ kind: 'stream_end' });
          emit({ id: item.id, kind: 'text', role: 'assistant', content: item.text || '' });
        } else if (item.type === 'commandExecution') {
          emit({ id: item.id, kind: 'tool_use', toolId: item.id, toolName: 'Bash',
            toolInput: { command: item.command, cwd: item.cwd }, output: item.aggregatedOutput,
            exitCode: item.exitCode, status: item.status });
        } else if (item.type === 'fileChange') {
          emit({ id: item.id, kind: 'tool_use', toolId: item.id, toolName: 'FileChanges',
            toolInput: item.changes, status: item.status });
        } else if (item.type === 'mcpToolCall') {
          emit({ id: item.id, kind: 'tool_use', toolId: item.id, toolName: `${item.server}/${item.tool}`,
            toolInput: item.arguments, output: item.result, status: item.status, isError: Boolean(item.error) });
        }
      }
      if (method === 'thread/tokenUsage/updated') {
        const total = params.tokenUsage?.total;
        if (total) emit({ kind: 'status', text: 'token_budget', tokenBudget: {
          used: total.totalTokens, total: params.tokenUsage.modelContextWindow,
        } });
      }
      if (method === 'turn/completed') {
        state.turnId = params.turn.id;
        finish(params.turn);
      }
      if (method === 'error' && !params.willRetry) fail(new Error(params.error?.message || 'Codex run failed'));
    });
    startupTimer = setTimeout(() => { fail(new Error('Codex startup timed out')); void rpc.close(); }, 60000);
    state.onInterrupt = () => { interruptTimer = setTimeout(() => { void rpc.close(); }, 7000); };
    await rpc.initialize();
    let model = options.model;
    if (!threadId && !model) {
      const models = await rpc.request('model/list');
      model = models.data?.find((entry) => entry.isDefault)?.model;
    }
    const threadOptions = {
      cwd, ...mapPermissionModeToCodexOptions(options.permissionMode), approvalsReviewer: 'user',
      ...(model ? { model } : {}),
    };
    const result = await rpc.request(threadId ? 'thread/resume' : 'thread/start',
      threadId ? { ...threadOptions, threadId } : threadOptions);
    if (threadId && result.thread.cwd && fs.realpathSync(result.thread.cwd) !== fs.realpathSync(cwd)) throw new Error('Codex thread belongs to a different project');
    if (threadId && result.thread.id !== threadId) throw new Error('Codex resumed a different thread');
    threadId = result.thread.id;
    codexOwnership.bind(lease, threadId);
    state.writer.setSessionId?.(threadId);
    activeCodexSessions.set(threadId, state);
    if (!options.sessionId) emit({ kind: 'session_created', newSessionId: threadId });
    emit({ kind: 'task_notification', status: 'info', summary: `Codex ${runtime.version} · ${runtime.executablePath}` });
    if (state.interrupted) throw new Error('Codex run cancelled');
    const turn = await rpc.request('turn/start', {
      threadId, input: [{ type: 'text', text: command, text_elements: [] }],
    });
    state.turnId = turn.turn.id;
    clearTimeout(startupTimer);
    const outcome = await completion;
    if (outcome.status === 'failed') throw new Error(outcome.error?.message || 'Codex turn failed');
    state.interrupted ||= outcome.status === 'interrupted';
    state.finished = true;
    terminalMessage = { kind: 'complete', actualSessionId: threadId, aborted: state.interrupted };
    notifySafely(notifyRunStopped, { userId: state.userId, provider: 'codex', sessionId: threadId,
      sessionName: options.sessionSummary, stopReason: state.interrupted ? 'aborted' : 'completed' });
  } catch (error) {
    state.finished = true;
    if (state.interrupted) terminalMessage = { kind: 'complete', aborted: true };
    else {
      terminalMessage = { kind: 'error', content: error.message };
      notifySafely(notifyRunFailed, { userId: state.userId, provider: 'codex', sessionId: threadId,
        sessionName: options.sessionSummary, error });
    }
  } finally {
    clearTimeout(startupTimer);
    clearTimeout(interruptTimer);
    state.finished = true;
    codexApprovals.clear(state.instanceId);
    await state.rpc?.close();
    if (activeCodexSessions.get(threadId) === state) activeCodexSessions.delete(threadId);
    pendingRuns.delete(state);
    if (lease) codexOwnership.release(lease);
    if (terminalMessage) emit(terminalMessage);
  }
}

export function resolveCodexApproval(requestId, userId, threadId, decision) {
  return codexApprovals.decide(requestId, userId, threadId, decision);
}

export function reconnectCodexSession(sessionId, writer) {
  const state = activeCodexSessions.get(sessionId);
  if (!state || state.userId === null || String(state.userId) !== String(writer.userId)) return false;
  state.writer = writer;
  codexApprovals.replay(writer.userId, sessionId, (message) => send(writer, message));
  return true;
}

export function abortCodexSession(sessionId, userId) {
  const state = activeCodexSessions.get(sessionId);
  if (!state || state.finished || (userId !== undefined && String(state.userId) !== String(userId))) return false;
  state.interrupted = true;
  state.onInterrupt?.();
  codexApprovals.clear(state.instanceId);
  if (state.turnId) {
    void state.rpc.request('turn/interrupt', { threadId: sessionId, turnId: state.turnId }, 5000)
      .catch(() => state.rpc.close());
  } else void state.rpc?.close();
  return true;
}

export function isCodexSessionActive(sessionId) { return activeCodexSessions.has(sessionId); }
export function getActiveCodexSessions() {
  return [...activeCodexSessions].map(([id, state]) => ({ id, status: state.status, startedAt: state.startedAt }));
}
export async function shutdownCodexSessions() {
  await Promise.all([...pendingRuns].map(async (state) => {
    state.interrupted = true;
    codexApprovals.clear(state.instanceId);
    await state.rpc?.close();
  }));
}
