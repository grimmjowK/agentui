/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import type { LLMProvider } from '../types/app';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification';

export interface NormalizedMessage {
  id: string;
  seq?: number;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Mirrors optional transcript metadata from the server.
   *
   * These fields are currently used by Claude history normalization so local
   * slash commands, local stdout, and compact summaries do not disappear when
   * the session store hydrates from REST history.
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  isInterrupted?: boolean;
  attachmentKind?: string;
  attachmentPath?: string;
  attachmentDetail?: string;
  isCompactBoundary?: boolean;
  images?: { data: string; name: string }[];
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  /** stream_end 專用：收尾後的助手文字要沿用的 id，與歷史中同一則訊息的 id 相同（id 契約）。 */
  messageId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  nextBeforeSeq: number | null;
  tokenUsage: unknown;
}

const EMPTY: NormalizedMessage[] = [];

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    nextBeforeSeq: null,
    tokenUsage: null,
  };
}

/**
 * Compute merged messages: server + realtime, deduped by id and adjacent
 * assistant echo (same trimmed text), so finalized stream rows do not stack
 * on top of the persisted copy before realtime is cleared.
 */
/**
 * 带图提交时 server/claude-sdk.js 会把图片临时路径追加到 prompt 末尾再落盘，
 * 所以服务端那条用户消息比客户端乐观消息多一段路径说明。去重前必须剥掉，
 * 否则两条文本永远不相等，同一句话会渲染成两个气泡。
 */
const IMAGE_PATH_NOTE_RE = /\n*\[Images provided at the following paths:\][\s\S]*$/;

export function stripImagePathNote(text: string): string {
  return text.replace(IMAGE_PATH_NOTE_RE, '').trimEnd();
}

function userTextFingerprint(m: NormalizedMessage): string | null {
  if (m.kind !== 'text' || m.role !== 'user') return null;
  const t = stripImagePathNote(m.content || '').trim();
  return t.length > 0 ? t : null;
}

const TRANSIENT_RETRY_ERROR_RE = /^API error \(attempt \d+\):/i;

function isTransientRetryRecovered(
  errorIndex: number,
  merged: NormalizedMessage[],
  before: NormalizedMessage[],
): boolean {
  const text = (merged[errorIndex]?.content || '').trim();
  if (!TRANSIENT_RETRY_ERROR_RE.test(text)) return false;

  const isAssistantProgress = (m: NormalizedMessage) =>
    (m.kind === 'text' && m.role === 'assistant' && Boolean(m.content?.trim()))
    || m.kind === 'tool_use'
    || m.kind === 'stream_delta';

  for (let i = before.length - 1; i >= 0; i--) {
    const m = before[i];
    if (m.kind === 'text' && m.role === 'user') break;
    if (isAssistantProgress(m)) return true;
  }

  for (let i = errorIndex + 1; i < merged.length; i++) {
    const m = merged[i];
    if (m.kind === 'text' && m.role === 'user') break;
    if (isAssistantProgress(m)) return true;
  }

  return false;
}

/**
 * After `finalizeStreaming`, the client holds a synthetic assistant `text` row
 * while the sessions API soon returns the same reply with a different id.
 * Those sit back-to-back in merged order and look like duplicate bubbles until
 * `refreshFromServer` clears realtime. Collapse same-text assistant rows and
 * stream_placeholder → text when content matches.
 */
function dedupeAdjacentAssistantEchoes(merged: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (let idx = 0; idx < merged.length; idx++) {
    const m = merged[idx];
    // 错误往往已经以正文形式出现过一次（如 Claude 先流出 "API Error: ..." 助手消息，
    // SDK 再抛出 "Claude Code returned an error result: API Error: ..."），
    // 实时错误行只是它的包装，再渲染一遍就是冗余。
    if (m.kind === 'error' && (isErrorAlreadyShown(m, out) || isTransientRetryRecovered(idx, merged, out))) continue;
    const prev = out[out.length - 1];
    if (prev) {
      if (prev.kind === 'stream_delta' && m.kind === 'text' && m.role === 'assistant') {
        const ps = (prev.content || '').trim();
        const ms = (m.content || '').trim();
        if (ps.length > 0 && ps === ms) {
          out[out.length - 1] = m;
          continue;
        }
      }
      if (
        prev.kind === 'text'
        && m.kind === 'text'
        && prev.role === 'assistant'
        && m.role === 'assistant'
      ) {
        const ms = (m.content || '').trim();
        if (ms.length > 0 && ms === (prev.content || '').trim()) {
          continue;
        }
      }
    }
    out.push(m);
  }
  return out;
}

function isErrorAlreadyShown(error: NormalizedMessage, before: NormalizedMessage[]): boolean {
  const text = (error.content || '').trim();
  if (!text) return false;
  // 只在本轮内查找：遇到用户消息即停，重试后同样的失败仍需提示
  for (let i = before.length - 1; i >= 0; i--) {
    const m = before[i];
    if (m.kind === 'text' && m.role === 'user') return false;
    if (m.kind !== 'error' && !(m.kind === 'text' && m.role === 'assistant')) continue;
    const shown = (m.content || '').trim();
    // ponytail: 子串匹配，短于 20 字的文本（如 "Error"）不参与，避免误吞不同的错误
    if (shown.length >= 20 && text.includes(shown)) return true;
  }
  return false;
}

/**
 * 把实时独有的消息（保留的错误、中断标记、未被服务端认领的乐观用户消息、
 * 仍在流式中的回复）按时间戳插回服务端序列，而不是一律追加到末尾。
 * 否则 refresh 之后旧错误会沉到新回复下面，未匹配上的用户提问会跑到回答后面。
 * 时间戳无效的消息维持原行为：放在最后。
 */
export function interleaveByTimestamp(base: NormalizedMessage[], extra: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  const undated: NormalizedMessage[] = [];
  let i = 0;
  for (const m of extra) {
    const t = Date.parse(m.timestamp);
    if (Number.isNaN(t)) {
      undated.push(m);
      continue;
    }
    // ponytail: 依赖客户端与服务端时钟基本一致；远程部署时钟偏差超过一轮对话间隔才会错位
    while (i < base.length && !(Date.parse(base[i].timestamp) > t)) {
      out.push(base[i++]);
    }
    out.push(m);
  }
  while (i < base.length) out.push(base[i++]);
  return out.concat(undated);
}

/**
 * 歷史為準，即時訊息只補歷史還沒有的欄位（例如執行中尚未寫入的 toolResult）。
 * 不能反過來覆蓋：Antigravity 即時的 toolInput 只有摘要（content/old_string 為空字串），
 * 會蓋掉歷史裡的完整 diff。
 */
function overlayDefinedFields(server: NormalizedMessage, live: NormalizedMessage): NormalizedMessage {
  const out = { ...server } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(live)) {
    if (value !== undefined && value !== null && (out[key] === undefined || out[key] === null)) out[key] = value;
  }
  return out as unknown as NormalizedMessage;
}

export function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) return server;
  if (server.length === 0) return dedupeAdjacentAssistantEchoes(realtime);
  const serverIds = new Set(server.map(m => m.id));
  const serverUserTexts = new Set(
    server.map(userTextFingerprint).filter((t): t is string => t !== null),
  );
  // 被丢弃的乐观消息上挂着本地图片缩略图（服务端历史里没有图片数据），
  // 按文本指纹记下来，回填到对应的服务端消息上，否则气泡里的缩略图会消失。
  const droppedImages = new Map<string, NormalizedMessage['images']>();
  // id 契約：同 id 代表同一則訊息。執行中拉到的歷史可能還沒寫入工具輸出，
  // 所以不是直接丟掉即時版本，而是用它補上歷史缺的欄位（其餘一律以歷史為準）。
  const realtimeOverlays = new Map<string, NormalizedMessage>();
  const extra = realtime.filter((m) => {
    if (serverIds.has(m.id)) {
      realtimeOverlays.set(m.id, m);
      return false;
    }
    // Optimistic user rows use `local_*` ids; once the same text exists on the
    // server-backed copy, drop the realtime echo to avoid duplicate bubbles.
    if (m.id.startsWith('local_')) {
      const fp = userTextFingerprint(m);
      if (fp && serverUserTexts.has(fp)) {
        if (m.images?.length) droppedImages.set(fp, m.images);
        return false;
      }
    }
    return true;
  });
  const base = droppedImages.size === 0 && realtimeOverlays.size === 0
    ? server
    : server.map((m) => {
        const overlay = realtimeOverlays.get(m.id);
        const merged = overlay ? overlayDefinedFields(m, overlay) : m;
        if (merged.images?.length) return merged;
        const fp = userTextFingerprint(merged);
        const images = fp ? droppedImages.get(fp) : undefined;
        return images ? { ...merged, images } : merged;
      });
  if (extra.length === 0) return base;
  return dedupeAdjacentAssistantEchoes(interleaveByTimestamp(base, extra));
}

function compareMessagesByTimestamp(left: NormalizedMessage, right: NormalizedMessage): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);

  if (Number.isNaN(leftTime) || Number.isNaN(rightTime) || leftTime === rightTime) {
    return 0;
  }

  return leftTime - rightTime;
}

function rewriteMessageSessionId(
  msg: NormalizedMessage,
  fromSessionId: string,
  toSessionId: string,
): NormalizedMessage {
  const streamingSourceId = `__streaming_${fromSessionId}`;
  const nextId = msg.id === streamingSourceId ? `__streaming_${toSessionId}` : msg.id;

  if (msg.sessionId === toSessionId && nextId === msg.id) {
    return msg;
  }

  return {
    ...msg,
    id: nextId,
    sessionId: toSessionId,
  };
}

function mergeMessagesById(
  existing: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  if (existing.length === 0) return incoming;
  if (incoming.length === 0) return existing;

  const merged = [...existing, ...incoming];
  const deduped: NormalizedMessage[] = [];
  const seen = new Set<string>();

  for (const msg of merged) {
    if (seen.has(msg.id)) {
      continue;
    }

    seen.add(msg.id);
    deduped.push(msg);
  }

  deduped.sort(compareMessagesByTimestamp);
  return deduped;
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;

function compareBySeq(left: NormalizedMessage, right: NormalizedMessage): number {
  const leftSeq = typeof left.seq === 'number' ? left.seq : Number.POSITIVE_INFINITY;
  const rightSeq = typeof right.seq === 'number' ? right.seq : Number.POSITIVE_INFINITY;
  if (leftSeq !== rightSeq) return leftSeq - rightSeq;
  return left.id.localeCompare(right.id);
}

function upsertMessage(
  messages: NormalizedMessage[],
  incoming: NormalizedMessage,
): NormalizedMessage[] {
  const next = [...messages];
  const index = next.findIndex((message) => message.id === incoming.id);
  const previous = index >= 0 ? next[index] : undefined;
  const merged = previous ? { ...previous, ...incoming } : incoming;
  if (previous?.images?.length && incoming.role === 'user' && incoming.kind === 'text') {
    merged.images = incoming.images?.length ? incoming.images : previous.images;
  }
  if (index >= 0) next[index] = merged;
  else next.push(merged);
  return next.sort(compareBySeq);
}

function buildLogMerged(slot: SessionSlot): NormalizedMessage[] {
  const persistent = [...slot.serverMessages].sort(compareBySeq);
  const transient = slot.realtimeMessages.filter((message) => typeof message.seq !== 'number');
  const persistentIds = new Set(persistent.map((message) => message.id));
  return [
    ...persistent,
    ...transient.filter((message) => !persistentIds.has(message.id)),
  ];
}

/**
 * Applies one realtime durable row to a session slot. Durable rows are upserted
 * into the single sequence-ordered collection; optimistic/stream rows remain at
 * the tail until the server assigns them a sequence.
 */
export function applyLogMessage(slot: SessionSlot, message: NormalizedMessage): SessionSlot {
  if (typeof message.seq !== 'number') {
    const nextRealtime = upsertMessage(slot.realtimeMessages, message);
    slot.realtimeMessages = nextRealtime.length > MAX_REALTIME_MESSAGES
      ? nextRealtime.slice(-MAX_REALTIME_MESSAGES)
      : nextRealtime;
    slot.merged = buildLogMerged(slot);
    return slot;
  }

  const previous = [...slot.serverMessages, ...slot.realtimeMessages]
    .find((entry) => entry.id === message.id);
  const incomingHasImageData = message.images?.some((image) => Boolean(image.data));
  const withLocalImages = previous?.images?.length
    && message.role === 'user'
    && message.kind === 'text'
    && !incomingHasImageData
    ? { ...message, images: previous.images }
    : message;
  slot.serverMessages = upsertMessage(slot.serverMessages, withLocalImages);
  slot.realtimeMessages = slot.realtimeMessages.filter((entry) => (
    entry.id !== message.id
    && !(message.kind === 'text' && entry.id === `__streaming_${message.sessionId}`)
  ));
  slot.merged = buildLogMerged(slot);
  return slot;
}

/**
 * Replaces all durable rows from a fetch while retaining optimistic messages
 * and the current streaming placeholder at the tail.
 */
export function replaceWithFetched(
  slot: SessionSlot,
  messages: NormalizedMessage[],
): SessionSlot {
  const incoming = messages
    .filter((message) => typeof message.seq === 'number')
    .sort(compareBySeq);
  const incomingIds = new Set(incoming.map((message) => message.id));
  const previous = new Map(
    [...slot.serverMessages, ...slot.realtimeMessages].map((message) => [message.id, message]),
  );
  slot.serverMessages = incoming.map((message) => {
    const local = previous.get(message.id);
    const incomingHasImageData = message.images?.some((image) => Boolean(image.data));
    if (local?.images?.length && message.role === 'user' && !incomingHasImageData) {
      return { ...message, images: local.images };
    }
    return message;
  });
  slot.realtimeMessages = slot.realtimeMessages.filter((message) => (
    !incomingIds.has(message.id)
    && (
      typeof message.seq !== 'number'
      && (
        message.kind === 'stream_delta'
        || (message.kind === 'text' && message.role === 'user')
      )
    )
  ));
  slot.merged = buildLogMerged(slot);
  return slot;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const sessionAliasesRef = useRef(new Map<string, string>());
  const activeSessionIdRef = useRef<string | null>(null);
  const logModeRef = useRef(true);
  // Bump to force re-render — only when the active session's data changes
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void authenticatedFetch('/api/config')
      .then(async (response) => response.ok ? response.json() : null)
      .then((config) => {
        if (cancelled || !config) return;
        logModeRef.current = config.sessionMessageLogEnabled !== false;
        for (const slot of storeRef.current.values()) {
          if (logModeRef.current) {
            slot.merged = buildLogMerged(slot);
          } else {
            slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
          }
          slot._lastServerRef = slot.serverMessages;
          slot._lastRealtimeRef = slot.realtimeMessages;
        }
        setTick((value) => value + 1);
      })
      .catch(() => {
        // The default is the new path; a config failure must not blank chat.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const notify = useCallback((sessionId: string) => {
    const aliases = sessionAliasesRef.current;
    let resolvedSessionId = sessionId;
    const visited = new Set<string>();

    while (aliases.has(resolvedSessionId) && !visited.has(resolvedSessionId)) {
      visited.add(resolvedSessionId);
      resolvedSessionId = aliases.get(resolvedSessionId)!;
    }

    if (resolvedSessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const resolveSessionId = useCallback((sessionId: string | null | undefined): string | null => {
    if (!sessionId) {
      return null;
    }

    const aliases = sessionAliasesRef.current;
    let resolvedSessionId = sessionId;
    const visited = new Set<string>();

    while (aliases.has(resolvedSessionId) && !visited.has(resolvedSessionId)) {
      visited.add(resolvedSessionId);
      resolvedSessionId = aliases.get(resolvedSessionId)!;
    }

    return resolvedSessionId;
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = resolveSessionId(sessionId);
  }, [resolveSessionId]);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const store = storeRef.current;
    if (!store.has(resolvedSessionId)) {
      store.set(resolvedSessionId, createEmptySlot());
    }
    return store.get(resolvedSessionId)!;
  }, [resolveSessionId]);

  const has = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    return storeRef.current.has(resolvedSessionId);
  }, [resolveSessionId]);

  /**
   * Fetch messages from the provider sessions endpoint and populate serverMessages.
   *
   * Provider and project metadata are resolved server-side from `sessionId`.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
      limit?: number | null;
      offset?: number;
      beforeSeq?: number;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    slot.status = 'loading';
    notify(resolvedSessionId);

    try {
      const params = new URLSearchParams();
      if (opts.limit !== null && opts.limit !== undefined) {
        params.append('limit', String(opts.limit));
        if (logModeRef.current && opts.beforeSeq !== undefined) {
          params.append('beforeSeq', String(opts.beforeSeq));
        } else {
          params.append('offset', String(opts.offset ?? 0));
        }
      }

      const qs = params.toString();
      const url = `/api/providers/sessions/${encodeURIComponent(resolvedSessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const messages: NormalizedMessage[] = data.messages || [];

      if (logModeRef.current) {
        replaceWithFetched(slot, messages);
      } else {
        slot.serverMessages = messages;
      }
      slot.total = data.total ?? messages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = (opts.offset ?? 0) + messages.length;
      slot.nextBeforeSeq = typeof data.nextBeforeSeq === 'number'
        ? data.nextBeforeSeq
        : messages.reduce<number | null>((minimum, message) => (
          typeof message.seq === 'number' && (minimum === null || message.seq < minimum)
            ? message.seq
            : minimum
        ), null);
      slot.fetchedAt = Date.now();
      slot.status = 'idle';
      if (logModeRef.current) {
        slot.merged = buildLogMerged(slot);
        slot._lastServerRef = slot.serverMessages;
        slot._lastRealtimeRef = slot.realtimeMessages;
      } else {
        recomputeMergedIfNeeded(slot);
      }
      if (data.tokenUsage) {
        slot.tokenUsage = data.tokenUsage;
      }

      notify(resolvedSessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetch failed for ${resolvedSessionId}:`, error);
      slot.status = 'error';
      notify(resolvedSessionId);
      return slot;
    }
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
      limit?: number;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    if (!slot.hasMore) return slot;

    const params = new URLSearchParams();
    const limit = opts.limit ?? 20;
    params.append('limit', String(limit));
    if (logModeRef.current && slot.nextBeforeSeq !== null) {
      params.append('beforeSeq', String(slot.nextBeforeSeq));
    } else {
      params.append('offset', String(slot.offset));
    }

    const qs = params.toString();
    const url = `/api/providers/sessions/${encodeURIComponent(resolvedSessionId)}/messages${qs ? `?${qs}` : ''}`;

    try {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const olderMessages: NormalizedMessage[] = data.messages || [];

      if (logModeRef.current) {
        for (const message of olderMessages) {
          slot.serverMessages = upsertMessage(slot.serverMessages, message);
        }
        slot.merged = buildLogMerged(slot);
        slot._lastServerRef = slot.serverMessages;
        slot._lastRealtimeRef = slot.realtimeMessages;
      } else {
        // Prepend older messages (they're earlier in the conversation)
        slot.serverMessages = [...olderMessages, ...slot.serverMessages];
        recomputeMergedIfNeeded(slot);
      }
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = slot.offset + olderMessages.length;
      slot.nextBeforeSeq = typeof data.nextBeforeSeq === 'number'
        ? data.nextBeforeSeq
        : olderMessages.reduce<number | null>((minimum, message) => (
          typeof message.seq === 'number' && (minimum === null || message.seq < minimum)
            ? message.seq
            : minimum
        ), slot.nextBeforeSeq);
      notify(resolvedSessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${resolvedSessionId}:`, error);
      return slot;
    }
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const normalizedMessage =
      msg.sessionId === resolvedSessionId
        ? msg
        : { ...msg, sessionId: resolvedSessionId };
    if (logModeRef.current) {
      applyLogMessage(slot, normalizedMessage);
      slot._lastServerRef = slot.serverMessages;
      slot._lastRealtimeRef = slot.realtimeMessages;
      notify(resolvedSessionId);
      return;
    }
    const existingIndex = normalizedMessage.id
      ? slot.realtimeMessages.findIndex((existing) => existing.id === normalizedMessage.id)
      : -1;
    let updated: NormalizedMessage[];
    if (existingIndex !== -1) {
      updated = [...slot.realtimeMessages];
      updated[existingIndex] = { ...updated[existingIndex], ...normalizedMessage };
    } else {
      updated = [...slot.realtimeMessages, normalizedMessage];
      if (updated.length > MAX_REALTIME_MESSAGES) {
        updated = updated.slice(-MAX_REALTIME_MESSAGES);
      }
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const normalizedMessages = msgs.map((msg) =>
      msg.sessionId === resolvedSessionId
        ? msg
        : { ...msg, sessionId: resolvedSessionId },
    );
    if (logModeRef.current) {
      for (const message of normalizedMessages) applyLogMessage(slot, message);
      slot._lastServerRef = slot.serverMessages;
      slot._lastRealtimeRef = slot.realtimeMessages;
      notify(resolvedSessionId);
      return;
    }
    let updated = [...slot.realtimeMessages, ...normalizedMessages];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  const removeRealtimeMessage = useCallback((sessionId: string, messageId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return;
    slot.serverMessages = slot.serverMessages.filter((message) => message.id !== messageId);
    slot.realtimeMessages = slot.realtimeMessages.filter((message) => message.id !== messageId);
    if (logModeRef.current) {
      slot.merged = buildLogMerged(slot);
      slot._lastServerRef = slot.serverMessages;
      slot._lastRealtimeRef = slot.realtimeMessages;
    } else {
      recomputeMergedIfNeeded(slot);
    }
    notify(resolvedSessionId);
  }, [notify, resolveSessionId]);

  /**
   * Re-fetch serverMessages from the provider sessions endpoint.
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
    _opts: {
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    try {
      const params = new URLSearchParams();

      const qs = params.toString();
      const url = `/api/providers/sessions/${encodeURIComponent(resolvedSessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      const messages: NormalizedMessage[] = data.messages || [];
      if (logModeRef.current) {
        replaceWithFetched(slot, messages);
        slot.total = data.total ?? slot.serverMessages.length;
        slot.hasMore = Boolean(data.hasMore);
        slot.nextBeforeSeq = typeof data.nextBeforeSeq === 'number'
          ? data.nextBeforeSeq
          : slot.serverMessages.reduce<number | null>((minimum, message) => (
            typeof message.seq === 'number' && (minimum === null || message.seq < minimum)
              ? message.seq
              : minimum
          ), null);
        slot.fetchedAt = Date.now();
        slot._lastServerRef = slot.serverMessages;
        slot._lastRealtimeRef = slot.realtimeMessages;
        notify(resolvedSessionId);
        return;
      }

      slot.serverMessages = messages;
      slot.total = data.total ?? slot.serverMessages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.fetchedAt = Date.now();
      // Drop realtime messages that the server has caught up with to prevent unbounded growth.
      // Retain messages that the server transcript never records (e.g. error messages)
      // and any optimistic user messages that the server hasn't committed yet.
      const serverUserTexts = new Set(
        slot.serverMessages.map(userTextFingerprint).filter((t): t is string => t !== null),
      );
      const lastServerMsg = slot.serverMessages[slot.serverMessages.length - 1];
      const serverEndedWithAssistant = Boolean(
        lastServerMsg
        && ((lastServerMsg.kind === 'text' && lastServerMsg.role === 'assistant') || lastServerMsg.kind === 'tool_use'),
      );
      slot.realtimeMessages = slot.realtimeMessages.filter((m) => {
        if (m.kind === 'error') {
          if (serverEndedWithAssistant && TRANSIENT_RETRY_ERROR_RE.test((m.content || '').trim())) {
            return false;
          }
          return true;
        }
        if (m.isInterrupted) return true;
        // 給使用者的警告不會寫進 provider 的歷史檔，刷新後也要保留
        if (m.kind === 'task_notification' && (m.status === 'warning' || m.status === 'error')) return true;
        if (m.id.startsWith('local_')) {
          const fp = userTextFingerprint(m);
          return fp ? !serverUserTexts.has(fp) : true;
        }
        return false;
      });
      recomputeMergedIfNeeded(slot);
      notify(resolvedSessionId);
    } catch (error) {
      console.error(`[SessionStore] refresh failed for ${resolvedSessionId}:`, error);
    }
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    slot.status = status;
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, [resolveSessionId]);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  const updateStreaming = useCallback((sessionId: string, accumulatedText: string, msgProvider: LLMProvider) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const streamId = `__streaming_${resolvedSessionId}`;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId: resolvedSessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    };
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = msg;
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    if (logModeRef.current) {
      slot.merged = buildLogMerged(slot);
      slot._lastServerRef = slot.serverMessages;
      slot._lastRealtimeRef = slot.realtimeMessages;
    } else {
      recomputeMergedIfNeeded(slot);
    }
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * 有 messageId（後端 stream_end 帶來、與歷史同一則訊息的 id）就沿用，
   * 隨後同 id 的 text 會覆蓋它，歷史拉取時也能按 id 去重；沒有才產生本地 id。
   */
  const finalizeStreaming = useCallback((sessionId: string, messageId?: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return;
    const streamId = `__streaming_${resolvedSessionId}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = messageId
        ? {
            ...stream,
            id: messageId,
            kind: 'text',
            role: 'assistant',
          }
        : stream;
      if (logModeRef.current) {
        slot.merged = buildLogMerged(slot);
        slot._lastServerRef = slot.serverMessages;
        slot._lastRealtimeRef = slot.realtimeMessages;
      } else if (messageId) {
        recomputeMergedIfNeeded(slot);
      } else {
        slot.realtimeMessages[idx] = {
          ...stream,
          id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          kind: 'text',
          role: 'assistant',
        };
        recomputeMergedIfNeeded(slot);
      }
      notify(resolvedSessionId);
    }
  }, [notify, resolveSessionId]);

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (slot) {
      slot.realtimeMessages = [];
      if (logModeRef.current) {
        slot.merged = buildLogMerged(slot);
        slot._lastServerRef = slot.serverMessages;
        slot._lastRealtimeRef = slot.realtimeMessages;
      } else {
        recomputeMergedIfNeeded(slot);
      }
      notify(resolvedSessionId);
    }
  }, [notify, resolveSessionId]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    return storeRef.current.get(resolvedSessionId)?.merged ?? [];
  }, [resolveSessionId]);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    return storeRef.current.get(resolvedSessionId);
  }, [resolveSessionId]);

  const replaceSessionId = useCallback((fromSessionId: string, toSessionId: string) => {
    const resolvedFromSessionId = resolveSessionId(fromSessionId) ?? fromSessionId;
    const resolvedToSessionId = resolveSessionId(toSessionId) ?? toSessionId;

    if (resolvedFromSessionId === resolvedToSessionId) {
      sessionAliasesRef.current.set(fromSessionId, resolvedToSessionId);
      return;
    }

    const store = storeRef.current;
    const sourceSlot = store.get(resolvedFromSessionId);
    const targetSlot = store.get(resolvedToSessionId) ?? createEmptySlot();

    if (sourceSlot) {
      const migratedServerMessages = sourceSlot.serverMessages.map((msg) =>
        rewriteMessageSessionId(msg, resolvedFromSessionId, resolvedToSessionId),
      );
      const migratedRealtimeMessages = sourceSlot.realtimeMessages.map((msg) =>
        rewriteMessageSessionId(msg, resolvedFromSessionId, resolvedToSessionId),
      );

      targetSlot.serverMessages = mergeMessagesById(targetSlot.serverMessages, migratedServerMessages);
      targetSlot.realtimeMessages = mergeMessagesById(targetSlot.realtimeMessages, migratedRealtimeMessages);
      if (targetSlot.realtimeMessages.length > MAX_REALTIME_MESSAGES) {
        targetSlot.realtimeMessages = targetSlot.realtimeMessages.slice(-MAX_REALTIME_MESSAGES);
      }
      targetSlot.status =
        sourceSlot.status === 'error'
          ? 'error'
          : sourceSlot.status === 'streaming' || targetSlot.status === 'streaming'
            ? 'streaming'
            : sourceSlot.status === 'loading' || targetSlot.status === 'loading'
              ? 'loading'
              : targetSlot.status;
      targetSlot.fetchedAt = Math.max(targetSlot.fetchedAt, sourceSlot.fetchedAt, Date.now());
      targetSlot.total = Math.max(
        targetSlot.total,
        sourceSlot.total,
        targetSlot.serverMessages.length,
        targetSlot.realtimeMessages.length,
      );
      targetSlot.hasMore = targetSlot.hasMore || sourceSlot.hasMore;
      targetSlot.offset = Math.max(targetSlot.offset, sourceSlot.offset);
      targetSlot.nextBeforeSeq = targetSlot.nextBeforeSeq === null
        ? sourceSlot.nextBeforeSeq
        : sourceSlot.nextBeforeSeq === null
          ? targetSlot.nextBeforeSeq
          : Math.min(targetSlot.nextBeforeSeq, sourceSlot.nextBeforeSeq);
      targetSlot.tokenUsage = targetSlot.tokenUsage ?? sourceSlot.tokenUsage;
      if (logModeRef.current) {
        targetSlot.serverMessages.sort(compareBySeq);
        targetSlot.merged = buildLogMerged(targetSlot);
        targetSlot._lastServerRef = targetSlot.serverMessages;
        targetSlot._lastRealtimeRef = targetSlot.realtimeMessages;
      } else {
        recomputeMergedIfNeeded(targetSlot);
      }

      store.set(resolvedToSessionId, targetSlot);
      store.delete(resolvedFromSessionId);
    }

    sessionAliasesRef.current.set(resolvedFromSessionId, resolvedToSessionId);
    sessionAliasesRef.current.set(fromSessionId, resolvedToSessionId);

    for (const [aliasSessionId, targetSessionId] of sessionAliasesRef.current.entries()) {
      if (targetSessionId === resolvedFromSessionId) {
        sessionAliasesRef.current.set(aliasSessionId, resolvedToSessionId);
      }
    }

    if (activeSessionIdRef.current === resolvedFromSessionId) {
      activeSessionIdRef.current = resolvedToSessionId;
    }

    notify(resolvedToSessionId);
  }, [notify, resolveSessionId]);

  return useMemo(() => ({
    getSlot,
    has,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    appendRealtimeBatch,
    removeRealtimeMessage,
    refreshFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    clearRealtime,
    getMessages,
    getSessionSlot,
    replaceSessionId,
  }), [
    getSlot, has, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, removeRealtimeMessage, refreshFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearRealtime, getMessages, getSessionSlot, replaceSessionId,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
