/** Codex chat runtime: app-server JSON-RPC, with explicit approval replies. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CodexAppServer } from './modules/codex-runtime/index.js';
import { codexOwnership } from './modules/codex-runtime/index.js';
import { codexApprovals } from './modules/codex-runtime/index.js';
import { terminateShellSessionsBySessionId } from './modules/websocket/services/shell-websocket.service.js';
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
  let resolveReleased;
  state.released = new Promise((resolve) => { resolveReleased = resolve; });
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
    // 版本号无法解析才硬性拒绝；低于最低已验证版本（unverified）仍尝试运行并告警。
    if (runtime.capabilities.status === 'unsupported') {
      throw new Error(`Codex ${runtime.version} at ${runtime.executablePath} 的版本号无法解析，无法确认 app-server 协议兼容性。见 docs/codex-runtime-protocol.md；不使用 exec 回退。`);
    }
    const cwd = options.cwd || options.projectPath || process.cwd();
    if (threadId) {
      await terminateShellSessionsBySessionId(threadId);
    }
    const modelName = options.model;
    const isDeepSeek = typeof modelName === 'string' && modelName.startsWith('deepseek');
    const profile = isDeepSeek
      ? (modelName.includes('flash') ? 'deepseek-flash' : 'deepseek')
      : undefined;

    lease = codexOwnership.acquire({ configRoot: runtime.configRoot, threadId, projectPath: cwd, userId: state.userId, owner: 'chat' });
    const rpc = new CodexAppServer(runtime.executablePath, cwd, runtime.configRoot, profile);
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
        const isCompleted = method === 'item/completed';
        if (item.type === 'agentMessage' && isCompleted) {
          if (streamed.has(item.id)) emit({ kind: 'stream_end' });
          emit({ id: item.id, kind: 'text', role: 'assistant', content: item.text || '' });
        } else if (item.type === 'commandExecution') {
          const isError = isCompleted && (item.status === 'failed' || item.status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0));
          emit({
            id: item.id, kind: 'tool_use', toolId: item.id, toolName: 'Bash',
            toolInput: { command: item.command, cwd: item.cwd }, output: item.aggregatedOutput,
            exitCode: item.exitCode, status: item.status,
            ...(isCompleted ? {
              toolResult: {
                content: item.aggregatedOutput || (isError ? `Exit code ${item.exitCode ?? 1}` : ''),
                isError,
              },
            } : {}),
          });
        } else if (item.type === 'fileChange') {
          const isError = isCompleted && (item.status === 'failed' || item.status === 'declined');
          emit({
            id: item.id, kind: 'tool_use', toolId: item.id, toolName: 'FileChanges',
            toolInput: item.changes, status: item.status,
            ...(isCompleted ? {
              toolResult: {
                content: isError ? `File changes ${item.status}` : 'Applied file changes',
                isError,
              },
            } : {}),
          });
        } else if (item.type === 'mcpToolCall') {
          const isError = Boolean(item.error) || (isCompleted && item.status === 'failed');
          const resultContent = item.error
            ? (typeof item.error === 'string' ? item.error : JSON.stringify(item.error))
            : item.result !== undefined
              ? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result))
              : '';
          emit({
            id: item.id, kind: 'tool_use', toolId: item.id, toolName: `${item.server}/${item.tool}`,
            toolInput: item.arguments, output: item.result, status: item.status, isError,
            ...(isCompleted ? {
              toolResult: {
                content: resultContent,
                isError,
              },
            } : {}),
          });
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
    // paginated thread 的全量 hydration 已 deprecated（0.163.0），resume 时带 excludeTurns:true
    // 只取元数据与 live-resume 状态，避免触发 "paginated_threads is not supported yet"。
    // 历史记录 agentui 另行从 ~/.codex rollout 文件读取，不依赖这里的 turns。
    const result = await rpc.request(threadId ? 'thread/resume' : 'thread/start',
      threadId ? { ...threadOptions, threadId, excludeTurns: true } : threadOptions);
    if (threadId && result.thread.cwd && fs.realpathSync(result.thread.cwd) !== fs.realpathSync(cwd)) throw new Error('Codex thread belongs to a different project');
    if (threadId && result.thread.id !== threadId) throw new Error('Codex resumed a different thread');
    threadId = result.thread.id;
    codexOwnership.bind(lease, threadId);
    state.writer.setSessionId?.(threadId);
    activeCodexSessions.set(threadId, state);
    if (!options.sessionId) emit({ kind: 'session_created', newSessionId: threadId });
    emit({ kind: 'task_notification', status: 'info', summary: `Codex ${runtime.version} · ${runtime.executablePath}` });
    if (runtime.capabilities.status === 'unverified') {
      emit({ kind: 'task_notification', status: 'warning',
        summary: `Codex ${runtime.version} 未通过 app-server 协议基线验证（见 docs/codex-runtime-protocol.md），功能可能不稳定。` });
    }
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
    if (state.interrupted) {
      emit({
        kind: 'text',
        role: 'user',
        content: '<turn_aborted>',
        isInterrupted: true,
      });
    }
    terminalMessage = { kind: 'complete', actualSessionId: threadId, aborted: state.interrupted };
    notifySafely(notifyRunStopped, { userId: state.userId, provider: 'codex', sessionId: threadId,
      sessionName: options.sessionSummary, stopReason: state.interrupted ? 'aborted' : 'completed' });
  } catch (error) {
    state.finished = true;
    if (state.interrupted) {
      emit({
        kind: 'text',
        role: 'user',
        content: '<turn_aborted>',
        isInterrupted: true,
      });
      terminalMessage = { kind: 'complete', aborted: true };
    } else {
      let errorMessage = error.message;
      if (typeof errorMessage === 'string' && (errorMessage.includes('array_above_max_length') || errorMessage.includes('array too long'))) {
        errorMessage = `${errorMessage}\n\n💡 提示：当前会话历史中包含不同模型提供商（如 DeepSeek）写入的专有上下文格式，目标提供商（如 OpenAI）无法直接兼容该历史。请切回原模型（DeepSeek）继续当前对话，或新建会话使用该模型。`;
      }
      terminalMessage = { kind: 'error', content: errorMessage };
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
    resolveReleased?.();
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

export async function stopCodexSessionAndWait(sessionId, userId) {
  const state = activeCodexSessions.get(sessionId);
  if (!state) return false;
  if (userId !== undefined && userId !== null && String(state.userId) !== String(userId)) return false;
  if (!state.finished) {
    state.interrupted = true;
    codexApprovals.clear(state.instanceId);
    void state.rpc?.close();
  }
  await state.released;
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
