/** Codex chat runtime: app-server JSON-RPC, with explicit approval replies. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { CodexAppServer, codexApprovals, codexOwnership } from './modules/codex-runtime/index.js';
import type { ThreadItem, ThreadStartParams, TurnCompletedNotification } from './modules/codex-runtime/index.js';
import { sessionsDb } from './modules/database/index.js';
import { mapPlanUpdate, mapThreadItem, notifySessionsChanged } from './modules/providers/index.js';
import { terminateShellSessionsBySessionId } from './modules/websocket/index.js';
import { getCodexRuntimeInfo } from './shared/codex-cli-path.js';
import { cleanupTempFiles, handleImages } from './shared/image-temp-files.js';
import { createNormalizedMessage, normalizeSessionName } from './shared/utils.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import type { ProviderRuntimeWriter } from './shared/interfaces.js';
import type { NormalizedMessage } from './shared/types.js';

const CODEX_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh']);

type CodexWriter = ProviderRuntimeWriter & {
  isWebSocketWriter?: boolean;
  isSSEStreamWriter?: boolean;
  readyState?: number;
};

type CodexRunOptions = {
  sessionId?: string;
  cwd?: string;
  projectPath?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  sessionSummary?: string;
  images?: unknown[];
};

type RunState = {
  instanceId: string;
  writer: CodexWriter;
  userId: string | number | null;
  rpc: CodexAppServer | null;
  turnId: string | null;
  status: 'running';
  startedAt: string;
  interrupted: boolean;
  finished: boolean;
  released?: Promise<void>;
  runtime?: ReturnType<typeof getCodexRuntimeInfo>;
  onInterrupt?: () => void;
};

type Turn = TurnCompletedNotification['turn'];
/** 送給前端的訊息；provider 由 send() 補上。 */
type Emitted = { kind: NormalizedMessage['kind'] } & Record<string, unknown>;

const activeCodexSessions = new Map<string, RunState>();
const pendingRuns = new Set<RunState>();
// notification-orchestrator 是 JS，推導出的參數型別過窄，這裡以寬鬆型別呼叫
function notifySafely(notify: (payload: any) => unknown, payload: Record<string, unknown>) {
  try { notify(payload); } catch (error) { console.warn('Codex notification delivery failed:', (error as Error).message); }
}

export function mapPermissionModeToCodexOptions(mode: unknown): Pick<ThreadStartParams, 'sandbox' | 'approvalPolicy'> {
  if (mode === 'bypassPermissions') return { sandbox: 'danger-full-access', approvalPolicy: 'never' };
  if (mode === 'acceptEdits') return { sandbox: 'workspace-write', approvalPolicy: 'never' };
  return { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
}

type TitleJob = {
  threadId: string; cwd: string; executablePath: string; configRoot: string;
  profile?: string; model?: string; prompt: string; reply: string;
};

const TITLE_SCHEMA = {
  type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false,
};

/**
 * SDK/app-server 起的會話不會像 Codex Desktop 那樣寫 thread_name，這裡補上：
 * 新會話第一輪結束後另起一個 app-server，用不落盤的 ephemeral thread 生成標題。
 * 沿用主會話的模型/profile；只寫 DB（auto 名，不蓋手動命名），失敗靜默放棄。
 */
export async function generateCodexTitle(job: TitleJob): Promise<void> {
  const rpc = new CodexAppServer(job.executablePath, job.cwd, job.configRoot, job.profile);
  const timer = setTimeout(() => { void rpc.close(); }, 60000);
  try {
    let text = '';
    const done = new Promise<void>((resolve, reject) => {
      rpc.on('notification', (notification) => {
        if (notification.method === 'item/completed' && notification.params.item?.type === 'agentMessage') {
          text = notification.params.item.text || text;
        } else if (notification.method === 'turn/completed') resolve();
        else if (notification.method === 'error' && !notification.params.willRetry) reject(new Error(notification.params.error?.message));
      });
      rpc.on('failure', reject);
      rpc.on('closed', () => reject(new Error('Codex app-server closed')));
    });
    void done.catch(() => {});
    // 標題生成不需要任何工具或授權
    rpc.on('request', (request) => rpc.send({ id: request.id, error: { code: -32601, message: 'Not supported' } }));
    await rpc.initialize();
    const { thread } = await rpc.request('thread/start', {
      cwd: job.cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      ...(job.model ? { model: job.model } : {}),
    });
    const instruction = [
      'Write a short title (at most 8 words) for the conversation below.',
      "Use the same language as the user's message. Do not use any tools. Respond with the title only.",
      '', '<user>', job.prompt.slice(0, 2000), '</user>', '<assistant>', job.reply.slice(0, 1000), '</assistant>',
    ].join('\n');
    await rpc.request('turn/start', {
      threadId: thread.id, input: [{ type: 'text', text: instruction, text_elements: [] }], outputSchema: TITLE_SCHEMA,
    });
    await done;
    const title = normalizeSessionName((JSON.parse(text) as { title?: string }).title, '');
    if (!title) return;
    sessionsDb.updateSessionCustomName(job.threadId, title, false);
    notifySessionsChanged('codex', job.threadId);
  } catch (error) {
    console.warn('Codex title generation failed:', (error as Error).message);
  } finally {
    clearTimeout(timer);
    await rpc.close();
  }
}

function send(writer: CodexWriter, message: Emitted) {
  const normalized = createNormalizedMessage({ provider: 'codex', ...message });
  if (writer.isWebSocketWriter || writer.isSSEStreamWriter) writer.send(normalized);
  else if (writer.readyState === undefined || writer.readyState === 1) writer.send(JSON.stringify(normalized));
}

export async function queryCodex(command: string, options: CodexRunOptions = {}, writer: CodexWriter) {
  let threadId: string | null = options.sessionId || null;
  const state: RunState = {
    instanceId: randomUUID(), writer, userId: writer.userId ?? null,
    rpc: null, turnId: null, status: 'running', startedAt: new Date().toISOString(),
    interrupted: false, finished: false,
  };
  const emit = (message: Emitted) => send(state.writer, { sessionId: threadId, ...message });
  let finish!: (turn: Turn) => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<Turn>((resolve, reject) => { finish = resolve; fail = reject; });
  // Failure can arrive during initialization, before completion is awaited.
  void completion.catch(() => {});
  let resolveReleased: (() => void) | undefined;
  state.released = new Promise((resolve) => { resolveReleased = resolve; });
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  let lease: ReturnType<typeof codexOwnership.acquire> | undefined;
  let terminalMessage: Emitted | undefined;
  const items = new Map<string, ThreadItem>();
  // delta 的 itemId 與 item/completed 的 item.id 格式不一致（0.163），不能按 id 配對；只記錄是否有未收尾的串流
  let streaming = false;
  let tempImagePaths: string[] = [];
  let tempDir: string | null = null;
  let titleJob: TitleJob | undefined;
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
    const imageResult = await handleImages(command, options.images, cwd);
    const finalCommand = imageResult.modifiedCommand;
    tempImagePaths = imageResult.tempImagePaths;
    tempDir = imageResult.tempDir;
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
      const { params } = request;
      const isElicitation = request.method === 'mcpServer/elicitation/request';
      const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'];
      if (!supported.includes(request.method) || state.userId === null || !threadId || params?.threadId !== threadId
        || (state.turnId && params.turnId !== state.turnId && !(isElicitation && params.turnId === null)) || state.interrupted || state.finished) {
        rpc.send({ id: request.id, error: { code: -32601, message: 'Unsupported or invalid Codex approval request' } });
        fail(new Error(`Unsupported or invalid Codex request: ${request.method}`));
        return;
      }
      // 額外權限的互動授權尚未在真實 Codex 上驗證（runtime capabilities.additionalPermissions=false），
      // 先自動拒絕（空權限）並提示，讓這一輪照常在原本的沙箱權限下繼續，而不是整輪失敗。
      if (request.method === 'item/permissions/requestApproval') {
        rpc.send({ id: request.id, result: { permissions: {}, scope: 'turn' } });
        const reason = 'reason' in params && params.reason ? `：${params.reason}` : '';
        emit({ kind: 'task_notification', status: 'warning',
          summary: `Codex 請求額外權限${reason}。目前不支援互動授權，已自動拒絕，這一輪繼續在原本的沙箱權限下執行。` });
        return;
      }
      codexApprovals.add({
        userId: state.userId, threadId, turnId: params.turnId ?? state.turnId ?? '', instanceId: state.instanceId,
        request, item: 'itemId' in params ? items.get(params.itemId) : undefined, notify: emit,
        reply: (result) => rpc.send({ id: request.id, result }),
      });
    });
    rpc.on('notification', (notification) => {
      // 型別只列出介接層處理的方法；其他通知會落到 default 被忽略
      const params = notification.params as { threadId?: string } | undefined;
      if (params?.threadId && params.threadId !== threadId) return;
      if (state.finished) return;
      switch (notification.method) {
        case 'turn/started':
          state.turnId = notification.params.turn.id;
          break;
        case 'item/agentMessage/delta':
          streaming = true;
          emit({ kind: 'stream_delta', content: notification.params.delta });
          break;
        case 'item/started':
        case 'item/completed': {
          const { item } = notification.params;
          if (!item) return;
          items.set(item.id, item);
          const isCompleted = notification.method === 'item/completed';
          if (item.type === 'agentMessage' && isCompleted) {
            // item.id 與 rollout 中該訊息的 payload.id 相同，收尾的文字沿用它，歷史拉取時才能按 id 去重
            if (streaming) { streaming = false; emit({ kind: 'stream_end', messageId: item.id }); }
            emit({ id: item.id, kind: 'text', role: 'assistant', content: item.text || '' });
          } else {
            for (const message of mapThreadItem(item, isCompleted ? 'completed' : 'started')) emit(message);
          }
          break;
        }
        case 'turn/plan/updated':
          for (const message of mapPlanUpdate(notification.params)) emit(message);
          break;
        case 'thread/tokenUsage/updated': {
          // last 是最近一轮实际送进模型的量，即上下文占用；total 是整个线程的累计值，会虚高
          const { last, modelContextWindow } = notification.params.tokenUsage ?? {};
          if (last && modelContextWindow) emit({ kind: 'status', text: 'token_budget', tokenBudget: {
            used: last.totalTokens, total: modelContextWindow,
          } });
          break;
        }
        case 'turn/completed':
          state.turnId = notification.params.turn.id;
          finish(notification.params.turn);
          break;
        case 'error':
          if (!notification.params.willRetry) fail(new Error(notification.params.error?.message || 'Codex run failed'));
          break;
        default:
          break;
      }
    });
    startupTimer = setTimeout(() => { fail(new Error('Codex startup timed out')); void rpc.close(); }, 60000);
    state.onInterrupt = () => { interruptTimer = setTimeout(() => { void rpc.close(); }, 7000); };
    await rpc.initialize();
    let model = options.model;
    if (!threadId && !model) {
      const models = await rpc.request('model/list', {});
      model = models.data?.find((entry) => entry.isDefault)?.model;
    }
    const threadOptions: ThreadStartParams = {
      cwd, ...mapPermissionModeToCodexOptions(options.permissionMode), approvalsReviewer: 'user',
      ...(model ? { model } : {}),
    };
    // paginated thread 的全量 hydration 已 deprecated（0.163.0），resume 时带 excludeTurns:true
    // 只取元数据与 live-resume 状态，避免触发 "paginated_threads is not supported yet"。
    // 历史记录 agentui 另行从 ~/.codex rollout 文件读取，不依赖这里的 turns。
    const result = threadId
      ? await rpc.request('thread/resume', { ...threadOptions, threadId, excludeTurns: true })
      : await rpc.request('thread/start', threadOptions);
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
    const turnInput = [
      ...(finalCommand.trim() ? [{ type: 'text' as const, text: finalCommand, text_elements: [] }] : []),
      ...tempImagePaths.map((imagePath) => ({ type: 'localImage' as const, path: imagePath })),
    ];
    const turn = await rpc.request('turn/start', {
      threadId, input: turnInput.length > 0 ? turnInput : [{ type: 'text', text: finalCommand, text_elements: [] }],
      // 推理强度对本轮及之后的轮次生效；未指定则沿用线程 / config.toml 的设置
      ...(options.effort && CODEX_EFFORT_LEVELS.has(options.effort) ? { effort: options.effort } : {}),
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
    const reply = [...items.values()].reverse().find((item) => item.type === 'agentMessage');
    if (!options.sessionId && !state.interrupted && command.trim()) {
      titleJob = {
        threadId, cwd, executablePath: runtime.executablePath, configRoot: runtime.configRoot, profile, model,
        prompt: command, reply: reply?.type === 'agentMessage' ? reply.text : '',
      };
    }
    notifySafely(notifyRunStopped, { userId: state.userId, provider: 'codex', sessionId: threadId,
      sessionName: options.sessionSummary, stopReason: state.interrupted ? 'aborted' : 'completed' });
  } catch (caught) {
    const error = caught as Error;
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
    await cleanupTempFiles(tempImagePaths, tempDir);
    if (threadId && activeCodexSessions.get(threadId) === state) activeCodexSessions.delete(threadId);
    pendingRuns.delete(state);
    if (lease) codexOwnership.release(lease);
    resolveReleased?.();
    if (terminalMessage) emit(terminalMessage);
    // 主流程（含 rpc 關閉、ownership 釋放）完成後才在背景生成標題，不拖慢這一輪
    if (titleJob) void generateCodexTitle(titleJob);
  }
}

type SteerableRun = Pick<RunState, 'userId' | 'turnId' | 'finished' | 'interrupted'> & {
  rpc: Pick<CodexAppServer, 'request'> | null;
};

/**
 * 依 D9 的前置條件把追加指令送進目前的 turn。任何失敗都只回傳 `{ ok: false }`，
 * 不呼叫 fail()、不關閉 app-server，這一輪照常執行。
 */
export async function steerRun(
  state: SteerableRun | undefined,
  threadId: string,
  userId: string | number | null,
  text: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!state) return { ok: false, reason: 'not_running' };
  if (userId === null || state.userId === null || String(state.userId) !== String(userId)) {
    return { ok: false, reason: 'not_owner' };
  }
  if (state.finished || state.interrupted) return { ok: false, reason: 'not_running' };
  if (!state.turnId || !state.rpc) return { ok: false, reason: 'turn_not_started' };
  if (!text.trim()) return { ok: false, reason: 'empty' };
  try {
    await state.rpc.request('turn/steer', {
      threadId, expectedTurnId: state.turnId,
      input: [{ type: 'text', text, text_elements: [] }],
    }, 10000);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

export function steerCodexSession(sessionId: string, userId: string | number | null, text: string) {
  return steerRun(activeCodexSessions.get(sessionId), sessionId, userId, text);
}

export function resolveCodexApproval(requestId: string, userId: string | number | null, threadId: string, decision: unknown) {
  return codexApprovals.decide(requestId, userId, threadId, decision);
}

export function listPendingCodexApprovals(userId: string | number | null, sessionId?: string) {
  return codexApprovals.listPending(userId, sessionId);
}

export function reconnectCodexSession(sessionId: string, writer: CodexWriter) {
  const state = activeCodexSessions.get(sessionId);
  if (!state || state.userId === null || String(state.userId) !== String(writer.userId)) return false;
  state.writer = writer;
  codexApprovals.replay(writer.userId ?? null, sessionId, (message) => send(writer, message));
  return true;
}

export function abortCodexSession(sessionId: string, userId?: string | number) {
  const state = activeCodexSessions.get(sessionId);
  if (!state || state.finished || (userId !== undefined && String(state.userId) !== String(userId))) return false;
  state.interrupted = true;
  state.onInterrupt?.();
  codexApprovals.clear(state.instanceId);
  if (state.turnId && state.rpc) {
    const { rpc } = state;
    void rpc.request('turn/interrupt', { threadId: sessionId, turnId: state.turnId }, 5000)
      .catch(() => rpc.close());
  } else void state.rpc?.close();
  return true;
}

export async function stopCodexSessionAndWait(sessionId: string, userId?: string | number | null) {
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

export function isCodexSessionActive(sessionId: string) { return activeCodexSessions.has(sessionId); }
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
