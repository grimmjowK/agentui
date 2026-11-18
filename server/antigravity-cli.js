/**
 * Antigravity 執行層：每一輪啟動一個 `agy acp` 行程（node-live-session-and-agy-acp design D7 / ACP D1–D8）。
 *
 * 流程：spawn `agy acp` → initialize → session/new 或 session/resume → session/set_mode → session/set_model
 *       → session/prompt；所有 session/prompt 都返回後送一次 complete，關閉行程。
 * - 審批：session/request_permission 進 antigravityApprovals，頁面決定後回覆；bypassPermissions 以
 *   `--dangerously-skip-permissions` 啟動（agy 1.5.11 實測可用），不由客戶端代答。
 * - 插話：同一條連線再送 session/prompt，由 agy 併入目前這一輪；有未決審批時 agy 會拒絕，直接回 waiting_approval。
 * - 中斷：session/cancel → 未決審批回覆已取消 → 等 prompt 以 cancelled 返回，7 秒內沒返回就結束行程。
 * - 歷史：ACP 即時事件沒有 step_index；一輪結束後讀 transcript，把即時訊息的 id 對到歷史 id（providerIds），
 *   讓歷史對帳能去重（見 linkLiveIdsToTranscript）。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createNormalizedMessage, generateMessageId } from './shared/utils.js';
import { resolveAntigravityExecutablePath } from './shared/antigravity-cli-path.js';
import { ensureAntigravitySessionInCliStore } from './shared/antigravity-session-store.js';
import { cleanupTempFiles, handleImages } from './shared/image-temp-files.js';
import {
  agyTextId,
  agyToolId,
  antigravityApprovals,
  AcpConnection,
  AcpRequestError,
  mapAcpUpdate,
  notifySessionsChanged,
  providerRegistry,
} from './modules/providers/index.js';
import { sessionMessagesDb, sessionsDb } from './modules/database/index.js';

const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

/** UI 權限模式 → ACP 模式；bypassPermissions 走 CLI 旗標 */
const ACP_MODES = { default: 'default', acceptEdits: 'accept-edits', auto: 'auto', plan: 'plan' };
const CANCEL_GRACE_MS = 7000;

/** @type {Map<string, AntigravityRun>} sessionId → 執行中的一輪 */
const activeRuns = new Map();

function send(writer, message) {
  if (!writer) return;
  writer.send(createNormalizedMessage({ provider: 'antigravity', ...message }));
}

export function createReconnectableWriter(writer) {
  return {
    isWebSocketWriter: true,
    userId: writer?.userId,
    send(message) {
      writer?.send(message);
    },
    setSessionId(sessionId) { writer?.setSessionId?.(sessionId); },
    reconnect(nextWriter) {
      if (this.userId !== nextWriter?.userId || !nextWriter?.ws) return false;
      if (typeof writer?.updateWebSocket === 'function') writer.updateWebSocket(nextWriter.ws);
      else writer = nextWriter;
      return true;
    },
  };
}

function antigravityBrainRoots() {
  const roots = [
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
  ];
  if (process.env.ANTIGRAVITY_HOME) {
    roots.unshift(path.join(process.env.ANTIGRAVITY_HOME, 'brain'));
  }
  return roots;
}

function findAntigravityTranscriptPath(sessionId) {
  if (!sessionId) return null;
  for (const root of antigravityBrainRoots()) {
    const nestedPath = path.join(root, sessionId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(nestedPath)) return nestedPath;
    const flatPath = path.join(root, sessionId, 'transcript.jsonl');
    if (fs.existsSync(flatPath)) return flatPath;
  }
  return null;
}

/**
 * Re-reads a completed session so a native title written after the immediate
 * post-run sync can replace the first-prompt fallback.
 */
export async function resyncAntigravitySessionMetadata(sessionId, transcriptPath) {
  if (!sessionId || !transcriptPath || !fs.existsSync(transcriptPath)) return false;
  const existing = sessionsDb.getSessionById(sessionId);
  if (!existing || existing.isArchived) return false;

  const synchronizer = providerRegistry.resolveProvider('antigravity')?.sessionSynchronizer;
  if (!synchronizer) return false;
  await synchronizer.synchronizeFile(transcriptPath);

  const updated = sessionsDb.getSessionById(sessionId);
  if (!updated || updated.custom_name === existing.custom_name) return false;
  notifySessionsChanged('antigravity', sessionId);
  return true;
}

function scheduleAntigravityMetadataResync(sessionId, transcriptPath) {
  const parsedDelay = Number.parseInt(process.env.ANTIGRAVITY_NATIVE_TITLE_RESYNC_DELAY_MS ?? '', 10);
  const delay = Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : 3000;
  const timer = setTimeout(() => {
    void resyncAntigravitySessionMetadata(sessionId, transcriptPath).catch((error) => {
      console.warn('Antigravity delayed session sync warning:', error.message);
    });
  }, delay);
  timer.unref?.();
}

/**
 * 把這一輪的即時訊息 id 對到 transcript 的歷史 id。
 * ACP 沒有 step_index，即時 tool_use 的 id 是 toolCallId、文字是隨機 id；transcript 以 step_index 編號。
 * 依「這一輪新增的步驟」順序配對：工具呼叫依序對 tool_calls，助理文字依序對有內容的 PLANNER_RESPONSE。
 * 配對不上就跳過，歷史對帳會在會話閒置時以 transcript 重建，不影響正確性。
 */
export function linkLiveIdsToTranscript(sessionId, transcriptPath, fromStepExclusive, liveTools, liveTexts) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;
  const toolIds = [];
  const textIds = [];
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry.step_index !== 'number' || entry.step_index <= fromStepExclusive) continue;
    if (entry.type !== 'PLANNER_RESPONSE') continue;
    if (typeof entry.content === 'string' && entry.content.trim()) textIds.push(agyTextId(sessionId, entry.step_index));
    if (Array.isArray(entry.tool_calls)) {
      entry.tool_calls.forEach((_, k) => toolIds.push(agyToolId(entry.step_index + 1 + k)));
    }
  }
  const link = (liveIds, historyIds) => {
    liveIds.forEach((liveId, i) => {
      if (historyIds[i]) sessionMessagesDb.updateProviderIds(sessionId, liveId, [historyIds[i]]);
    });
  };
  try {
    link(liveTools, toolIds);
    link(liveTexts, textIds);
  } catch (error) {
    console.warn('Antigravity transcript id linking warning:', error.message);
  }
}

function lastTranscriptStep(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return -1;
  let last = -1;
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const index = JSON.parse(line).step_index;
      if (typeof index === 'number' && index > last) last = index;
    } catch { /* ignore */ }
  }
  return last;
}

function friendlyError(error) {
  if (error instanceof AcpRequestError && /authentication required/i.test(error.message)) {
    return 'Antigravity CLI 尚未登入，請先在終端執行 `agy` 完成登入後再試。';
  }
  return error?.message || String(error);
}

/** 一輪 ACP 執行：負責串流段落、待返回的 prompt 計數、審批與中斷。 */
class AntigravityRun {
  constructor({ writer, sessionId, cwd, userId, notifyContext }) {
    this.writer = writer;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.userId = userId;
    this.notifyContext = notifyContext;
    this.instanceId = crypto.randomUUID();
    this.connection = null;
    this.outstanding = 0;
    this.finishing = false;
    this.aborted = false;
    this.error = null;
    this.segment = '';
    this.segmentId = null;
    this.liveTools = [];
    this.liveTexts = [];
    this.done = null;
    this.resolveDone = null;
  }

  // ---- 串流段落：文字一段一段收尾，工具或結束時送出完整 text ----
  appendText(text) {
    if (!text) return;
    if (!this.segmentId) this.segmentId = generateMessageId('agy_acp_msg');
    this.segment += text;
    send(this.writer, { sessionId: this.sessionId, kind: 'stream_delta', content: text });
  }

  endSegment() {
    if (!this.segmentId) return;
    const id = this.segmentId;
    send(this.writer, { sessionId: this.sessionId, kind: 'stream_end', messageId: id });
    send(this.writer, { sessionId: this.sessionId, id, kind: 'text', role: 'assistant', content: this.segment });
    this.liveTexts.push(id);
    this.segment = '';
    this.segmentId = null;
  }

  onUpdate(update) {
    if (!update) return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content?.type === 'text') this.appendText(update.content.text);
        return;
      case 'agent_thought_chunk':
        if (update.content?.type === 'text' && update.content.text) {
          send(this.writer, { sessionId: this.sessionId, kind: 'thinking', content: update.content.text });
        }
        return;
      case 'tool_call':
      case 'tool_call_update': {
        const mapped = mapAcpUpdate(update);
        if (!mapped) return;
        this.endSegment();
        if (mapped.kind === 'tool_use') {
          if (this.liveTools.includes(mapped.id)) return;
          this.liveTools.push(mapped.id);
        }
        send(this.writer, { sessionId: this.sessionId, ...mapped });
        return;
      }
      default:
        return;
    }
  }

  /** 送出一個 prompt；所有 prompt 都返回後收尾。 */
  sendPrompt(text) {
    this.outstanding += 1;
    this.connection.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, 0)
      .then((result) => {
        if (result?.stopReason === 'cancelled') this.aborted = true;
      })
      .catch((error) => {
        if (!this.aborted) this.error ??= friendlyError(error);
      })
      .finally(() => {
        this.outstanding -= 1;
        if (this.outstanding === 0) this.finish();
      });
  }

  steer(text) {
    if (this.finishing || this.aborted || !this.connection || this.connection.isClosed) return { ok: false, reason: 'not_running' };
    if (!text.trim()) return { ok: false, reason: 'empty' };
    // agy 在等待審批時會拒絕新的 prompt（-32603）；直接回覆，讓前端保留在佇列
    if (antigravityApprovals.hasPending(this.instanceId)) return { ok: false, reason: 'waiting_approval' };
    this.sendPrompt(text);
    return { ok: true };
  }

  async abort() {
    if (this.finishing || this.aborted) return false;
    this.aborted = true;
    antigravityApprovals.clearInstance(this.instanceId, 'aborted');
    this.connection?.notify('session/cancel', { sessionId: this.sessionId });
    const timer = setTimeout(() => {
      if (!this.finishing) this.connection?.kill();
    }, CANCEL_GRACE_MS);
    timer.unref?.();
    notifyRunStopped({ ...this.notifyContext, sessionId: this.sessionId, stopReason: 'aborted' });
    return true;
  }

  finish() {
    if (this.finishing) return;
    this.finishing = true;
    this.endSegment();
    antigravityApprovals.clearInstance(this.instanceId);
    this.connection?.close();
    this.resolveDone?.();
  }
}

/**
 * Launches one Antigravity ACP turn and pipes events to the provided writer.
 */
export async function spawnAntigravity(message, options = {}, ws) {
  const resumeId = options.sessionId || null;
  const cwd = options.cwd || options.projectPath || process.cwd();
  const liveWriter = createReconnectableWriter(ws);
  const userId = ws?.userId ?? null;
  const notifyContext = { userId: userId || null, provider: 'antigravity', sessionName: options.sessionSummary };

  if (resumeId) {
    try {
      await ensureAntigravitySessionInCliStore(resumeId);
    } catch (error) {
      const errorMsg = `Failed to prepare Antigravity conversation ${resumeId}: ${error.message}`;
      send(liveWriter, { sessionId: resumeId, kind: 'error', content: errorMsg });
      throw new Error(errorMsg);
    }
  }

  let executablePath;
  try {
    executablePath = resolveAntigravityExecutablePath();
  } catch {
    const errorMsg = 'Antigravity CLI (agy) is not installed or not found on PATH. '
      + 'Please install it first: https://www.antigravity.google/docs/cli/';
    send(liveWriter, { sessionId: resumeId, kind: 'error', content: errorMsg });
    throw new Error(errorMsg);
  }

  const { modifiedCommand, tempImagePaths, tempDir } = await handleImages(message, options.images, cwd);
  const args = ['acp'];
  if (options.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');

  let child;
  try {
    child = spawnFunction(executablePath, args, { cwd, env: { ...process.env, PAGER: 'cat' }, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    await cleanupTempFiles(tempImagePaths, tempDir);
    send(liveWriter, { sessionId: resumeId, kind: 'error', content: error.message });
    throw error;
  }

  const run = new AntigravityRun({ writer: liveWriter, sessionId: resumeId, cwd, userId, notifyContext });
  run.done = new Promise((resolve) => { run.resolveDone = resolve; });
  const register = (id) => {
    if (run.sessionId && run.sessionId !== id) activeRuns.delete(run.sessionId);
    run.sessionId = id;
    activeRuns.set(id, run);
  };
  if (resumeId) register(resumeId);

  run.connection = new AcpConnection(child, {
    onNotification: (method, params) => {
      if (method === 'session/update' && params?.sessionId === run.sessionId) run.onUpdate(params.update);
    },
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission') throw Object.assign(new Error(`Method not supported: ${method}`), { code: -32601 });
      run.endSegment();
      return antigravityApprovals.add({
        userId,
        sessionId: run.sessionId,
        instanceId: run.instanceId,
        toolCall: params?.toolCall ?? {},
        options: Array.isArray(params?.options) ? params.options : [],
        notify: (msg) => send(liveWriter, msg),
      });
    },
    onExit: () => {
      if (!run.finishing) {
        if (!run.aborted) run.error ??= `agy acp exited unexpectedly${run.connection.stderr ? `: ${run.connection.stderr.trim().slice(-300)}` : ''}`;
        run.finish();
      }
    },
  });

  let transcriptPath = null;
  let stepBefore = -1;
  try {
    const init = await run.connection.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (init?.protocolVersion !== 1) {
      throw new Error(`Unsupported ACP protocol version ${init?.protocolVersion} (agy ${init?.agentInfo?.version ?? 'unknown'})`);
    }

    if (resumeId) {
      transcriptPath = findAntigravityTranscriptPath(resumeId);
      stepBefore = lastTranscriptStep(transcriptPath);
      await run.connection.request('session/resume', { sessionId: resumeId, cwd, mcpServers: [] });
    } else {
      const created = await run.connection.request('session/new', { cwd, mcpServers: [] });
      register(created.sessionId);
      // 先登記會話再送 session_created，前端導向與歷史載入才找得到它
      const existing = sessionsDb.getSessionById(created.sessionId);
      sessionsDb.createSession(created.sessionId, 'antigravity', cwd,
        existing?.custom_name || options.sessionSummary || String(message || '').slice(0, 50),
        existing?.created_at, undefined, existing?.jsonl_path);
      liveWriter.setSessionId?.(created.sessionId);
      send(liveWriter, { kind: 'session_created', newSessionId: created.sessionId, sessionId: created.sessionId });
    }

    const mode = ACP_MODES[options.permissionMode];
    if (mode && mode !== 'default') {
      await run.connection.request('session/set_mode', { sessionId: run.sessionId, modeId: mode });
    }
    if (options.model) {
      await run.connection.request('session/set_model', { sessionId: run.sessionId, modelId: options.model });
    }

    if (run.aborted) run.finish();
    else run.sendPrompt(modifiedCommand);
  } catch (error) {
    run.error = friendlyError(error);
    run.finish();
  }

  await run.done;
  await cleanupTempFiles(tempImagePaths, tempDir);
  if (run.sessionId) activeRuns.delete(run.sessionId);

  // 結束後立即同步 transcript，並把即時 id 對到歷史 id
  try {
    transcriptPath = findAntigravityTranscriptPath(run.sessionId);
    if (transcriptPath) {
      const synchronizer = providerRegistry.resolveProvider('antigravity')?.sessionSynchronizer;
      if (synchronizer) await synchronizer.synchronizeFile(transcriptPath);
      linkLiveIdsToTranscript(run.sessionId, transcriptPath, stepBefore, run.liveTools, run.liveTexts);
    }
  } catch (error) {
    console.warn('Antigravity session post-run sync warning:', error);
  }
  if (!run.aborted && transcriptPath) scheduleAntigravityMetadataResync(run.sessionId, transcriptPath);

  if (run.aborted) {
    send(liveWriter, { sessionId: run.sessionId, kind: 'complete', aborted: true, success: true, exitCode: 0 });
    return;
  }
  if (run.error) {
    send(liveWriter, { sessionId: run.sessionId, kind: 'error', content: run.error });
    notifyRunFailed({ ...notifyContext, sessionId: run.sessionId, error: run.error });
    throw new Error(run.error);
  }
  send(liveWriter, { sessionId: run.sessionId, kind: 'complete', exitCode: 0, success: true });
  notifyRunStopped({ ...notifyContext, sessionId: run.sessionId, stopReason: 'completed' });
}

/** Aborts an active Antigravity turn (session/cancel). */
export function abortAntigravitySession(sessionId) {
  const run = activeRuns.get(sessionId);
  if (!run) return false;
  void run.abort();
  return true;
}

/** 執行中插話（ACP D8）。 */
export function steerAntigravitySession(sessionId, userId, text) {
  const run = activeRuns.get(sessionId);
  if (!run) return { ok: false, reason: 'not_running' };
  if (userId === null || userId === undefined || run.userId === null || run.userId === undefined
    || String(run.userId) !== String(userId)) {
    return { ok: false, reason: 'not_owner' };
  }
  return run.steer(text);
}

export function isAntigravitySessionActive(sessionId) {
  return activeRuns.has(sessionId);
}

export function reconnectAntigravitySession(sessionId, writer) {
  const run = activeRuns.get(sessionId);
  if (!run || !writer?.ws) return false;
  return run.writer?.reconnect?.(writer) === true;
}

export function getActiveAntigravitySessions() {
  return Array.from(activeRuns.keys());
}
