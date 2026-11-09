import crypto from 'node:crypto';

import { sessionMessagesDb } from '@/modules/database/index.js';
import type { ProviderRuntimeWriter } from '@/shared/interfaces.js';
import type { AnyRecord, LLMProvider, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

const MAX_PAYLOAD_BYTES = 512 * 1024;
const activeWriters = new Map<string, LoggingWriter>();

type LoggingWriterInner = ProviderRuntimeWriter & {
  ws?: unknown;
  sessionId?: string | null;
  updateWebSocket?: (ws: unknown) => void;
  getSessionId?: () => string | null;
  isWebSocketWriter?: boolean;
  isSSEStreamWriter?: boolean;
};

type LoggingWriterOptions = {
  initialSessionId?: string | null;
  userId?: string | number | null;
  provider?: LLMProvider;
};

type ImageMetadata = {
  name: string;
  mimeType?: string;
  byteLength?: number;
};

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isPersistentMessage(message: AnyRecord): boolean {
  if (message.isInterrupted === true || message.isCompactBoundary === true) {
    return true;
  }
  if (
    message.kind === 'text'
    || message.kind === 'thinking'
    || message.kind === 'tool_use'
    || message.kind === 'tool_result'
    || message.kind === 'error'
  ) {
    return true;
  }
  return message.kind === 'task_notification'
    && (message.status === 'warning' || message.status === 'error');
}

function imageMetadata(images: unknown): ImageMetadata[] | undefined {
  if (!Array.isArray(images)) return undefined;
  return images
    .filter(isRecord)
    .map((image) => {
      const data = typeof image.data === 'string' ? image.data : '';
      const mimeMatch = data.match(/^data:([^;,]+)[;,]/);
      return {
        name: typeof image.name === 'string' ? image.name : 'image',
        ...(mimeMatch ? { mimeType: mimeMatch[1] } : {}),
        ...(data ? { byteLength: Math.floor((data.length * 3) / 4) } : {}),
      };
    });
}

function truncateString(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;
  let result = value.slice(0, Math.max(0, limit));
  while (result.length > 0 && Buffer.byteLength(result, 'utf8') > limit) {
    result = result.slice(0, Math.floor(result.length * 0.9));
  }
  return `${result}\n\n[log payload truncated]`;
}

export function truncateMessagePayload(input: NormalizedMessage): NormalizedMessage {
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') <= MAX_PAYLOAD_BYTES) {
    return input;
  }

  let message: NormalizedMessage = {
    ...input,
    truncated: true,
  };

  for (const factor of [0.35, 0.15, 0.05]) {
    const perFieldLimit = Math.floor(MAX_PAYLOAD_BYTES * factor);
    const candidate: NormalizedMessage = {
      ...message,
      truncated: true,
    };
    if (typeof candidate.content === 'string') {
      candidate.content = truncateString(candidate.content, perFieldLimit);
    }
    if (typeof candidate.displayText === 'string') {
      candidate.displayText = truncateString(candidate.displayText, Math.floor(perFieldLimit / 2));
    }
    if (typeof candidate.text === 'string') {
      candidate.text = truncateString(candidate.text, Math.floor(perFieldLimit / 2));
    }
    if (candidate.toolResult) {
      const nextToolResult: AnyRecord = { ...candidate.toolResult };
      if (typeof nextToolResult.content === 'string') {
        nextToolResult.content = truncateString(nextToolResult.content, perFieldLimit);
      }
      if (nextToolResult.toolUseResult !== undefined) {
        const serializedResult = typeof nextToolResult.toolUseResult === 'string'
          ? nextToolResult.toolUseResult
          : JSON.stringify(nextToolResult.toolUseResult);
        if (Buffer.byteLength(serializedResult, 'utf8') > perFieldLimit) {
          nextToolResult.toolUseResult = {
            truncated: true,
            preview: truncateString(serializedResult, perFieldLimit),
          };
        }
      }
      candidate.toolResult = nextToolResult as NormalizedMessage['toolResult'];
    }
    for (const key of ['toolInput', 'input', 'context', 'toolUseResult', 'subagentTools']) {
      if (candidate[key] === undefined) continue;
      const serialized = typeof candidate[key] === 'string'
        ? candidate[key] as string
        : JSON.stringify(candidate[key]);
      if (Buffer.byteLength(serialized, 'utf8') > perFieldLimit) {
        (candidate as Record<string, unknown>)[key] = {
          truncated: true,
          preview: truncateString(serialized, perFieldLimit),
        };
      }
    }
    message = candidate;
    if (Buffer.byteLength(JSON.stringify(message), 'utf8') <= MAX_PAYLOAD_BYTES) {
      return message;
    }
  }
  return message;
}

function mergeRuntimeMessage(
  raw: AnyRecord,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage {
  return createNormalizedMessage({
    ...raw,
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    sessionId,
    provider: typeof raw.provider === 'string' ? raw.provider as LLMProvider : provider,
    kind: raw.kind as NormalizedMessage['kind'],
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
  });
}

/**
 * Durable transport wrapper. It is the only live path that assigns `seq` and
 * writes normalized messages before forwarding them to the real transport.
 */
export class LoggingWriter {
  readonly isWebSocketWriter = true;
  readonly runId = crypto.randomUUID();
  private readonly pending: NormalizedMessage[] = [];
  private readonly pendingIds = new Set<string>();
  private inner: LoggingWriterInner;
  private currentSessionId: string | null;
  private readonly hadInitialSessionId: boolean;
  private writerUserId: string | number | null;
  private provider: LLMProvider;
  private sessionCreatedForwarded = false;
  private interruptedSent = false;
  private streamingText = '';

  constructor(inner: LoggingWriterInner, options: LoggingWriterOptions = {}) {
    this.inner = inner;
    this.currentSessionId = options.initialSessionId || null;
    this.hadInitialSessionId = Boolean(this.currentSessionId);
    this.writerUserId = options.userId ?? inner.userId ?? null;
    this.provider = options.provider ?? 'claude';
    if (this.currentSessionId) {
      this.inner.setSessionId?.(this.currentSessionId);
      activeWriters.set(this.currentSessionId, this);
    }
  }

  get ws(): unknown {
    return this.inner.ws;
  }

  get userId(): string | number | null {
    return this.writerUserId;
  }

  set ws(value: unknown) {
    this.inner.ws = value;
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  set sessionId(value: string | null) {
    this.setSessionId(value);
  }

  getSessionId(): string | null {
    return this.currentSessionId;
  }

  setSessionId(sessionId: string | null): void {
    if (!sessionId) return;
    this.currentSessionId = sessionId;
    this.inner.setSessionId?.(sessionId);
    activeWriters.set(sessionId, this);
  }

  updateWebSocket(ws: unknown): void {
    if (this.inner.updateWebSocket) {
      this.inner.updateWebSocket(ws);
    } else {
      this.inner.ws = ws;
    }
  }

  send(raw: unknown): void {
    const parsed = typeof raw === 'string' ? this.parseString(raw) : raw;
    if (!isRecord(parsed)) {
      this.inner.send(parsed);
      return;
    }

    const message = parsed;
    if (message.kind === 'session_created') {
      const createdId = typeof message.newSessionId === 'string'
        ? message.newSessionId
        : typeof message.sessionId === 'string'
          ? message.sessionId
          : null;
      if (createdId) this.setSessionId(createdId);
      this.inner.send(message);
      this.sessionCreatedForwarded = true;
      this.flushPending();
      return;
    }

    if (message.kind === 'stream_delta') {
      if (typeof message.content === 'string') {
        this.streamingText += message.content;
      }
      this.inner.send(message);
      return;
    }

    if (message.kind === 'stream_end') {
      this.streamingText = '';
      this.inner.send(message);
      return;
    }

    if (message.kind === 'complete') {
      if (this.currentSessionId && (this.hadInitialSessionId || this.sessionCreatedForwarded)) {
        this.flushPending();
      } else if (this.pending.length > 0) {
        for (const pendingMsg of this.pending.splice(0)) {
          this.inner.send(pendingMsg);
        }
        this.pendingIds.clear();
      }
      if (message.aborted === true) this.sendInterruptedMarker(message);
      if (message.aborted === true || message.success === true) {
        this.streamingText = '';
      }
      this.inner.send(message);
      this.finish();
      return;
    }

    if (!isPersistentMessage(message)) {
      this.inner.send(message);
      return;
    }

    const normalized = this.prepareMessage(message);
    if (!this.currentSessionId || (!this.hadInitialSessionId && !this.sessionCreatedForwarded)) {
      this.queuePending(normalized);
      return;
    }
    this.persistAndSend(normalized);
  }

  recordUserMessage(input: {
    clientId: string;
    content: string;
    images?: unknown;
    provider: LLMProvider;
    sessionId?: string | null;
  }): NormalizedMessage {
    if (input.sessionId) this.setSessionId(input.sessionId);
    const message = createNormalizedMessage({
      id: `user:${input.clientId}`,
      sessionId: this.currentSessionId ?? '',
      timestamp: new Date().toISOString(),
      provider: input.provider,
      kind: 'text',
      role: 'user',
      content: input.content,
      ...(imageMetadata(input.images) ? { images: imageMetadata(input.images) } : {}),
    });

    if (!this.currentSessionId) {
      this.queuePending(message);
      return message;
    }

    let result: ReturnType<typeof sessionMessagesDb.insertUserIfAbsent>;
    try {
      result = sessionMessagesDb.insertUserIfAbsent(
        this.currentSessionId,
        message,
        this.writerUserId,
      );
    } catch (error) {
      // DB 故障不該擋住使用者送出；只有 clientId 衝突才拒絕
      console.warn('[LoggingWriter] failed to persist user message; forwarding without log', error);
      this.inner.send(message);
      return message;
    }
    if (result.status === 'conflict' || !result.message) {
      throw new Error('clientId conflicts with an existing session message');
    }
    this.inner.send(result.message);
    return result.message;
  }

  replayAfterSeq(afterSeq: number | null): void {
    if (!this.currentSessionId) return;
    // afterSeq 為 null 表示前端還沒有任何持久化訊息，首屏由 HTTP 分頁載入；
    // 這裡若全量重播，長會話會被整段推過 WS，分頁失效。
    if (afterSeq !== null) {
      const page = sessionMessagesDb.list(this.currentSessionId, {
        afterSeq,
        limit: null,
      });
      for (const message of page.messages) {
        this.inner.send(message);
      }
    }
    if (this.streamingText) {
      this.inner.send({
        kind: 'stream_delta',
        sessionId: this.currentSessionId,
        provider: this.provider,
        content: this.streamingText,
      });
    }
  }

  hasStreamingText(): boolean {
    return this.streamingText.length > 0;
  }

  finish(): void {
    if (this.currentSessionId && (this.hadInitialSessionId || this.sessionCreatedForwarded)) {
      if (this.pending.length > 0) this.flushPending();
      if (activeWriters.get(this.currentSessionId) === this) {
        activeWriters.delete(this.currentSessionId);
      }
    } else {
      if (this.currentSessionId && activeWriters.get(this.currentSessionId) === this) {
        activeWriters.delete(this.currentSessionId);
      }
      for (const message of this.pending.splice(0)) {
        this.inner.send(message);
      }
      this.pendingIds.clear();
    }
    this.streamingText = '';
  }

  private parseString(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      console.warn('[LoggingWriter] Runtime sent a non-JSON string; forwarding unchanged');
      return raw;
    }
  }

  private prepareMessage(input: AnyRecord): NormalizedMessage {
    if (!this.currentSessionId) {
      return createNormalizedMessage({
        ...input,
        id: typeof input.id === 'string' && input.id ? input.id : crypto.randomUUID(),
        provider: typeof input.provider === 'string' ? input.provider as LLMProvider : this.provider,
        kind: input.kind as NormalizedMessage['kind'],
      });
    }
    const normalized = mergeRuntimeMessage(input, this.currentSessionId, this.provider);
    if (Array.isArray(normalized.images)) {
      normalized.images = imageMetadata(normalized.images);
    }
    return truncateMessagePayload(normalized);
  }

  private queuePending(message: NormalizedMessage): void {
    if (this.pendingIds.has(message.id)) {
      const index = this.pending.findIndex((entry) => entry.id === message.id);
      if (index >= 0) this.pending[index] = { ...this.pending[index], ...message };
      return;
    }
    this.pending.push(message);
    this.pendingIds.add(message.id);
  }

  private flushPending(): void {
    if (!this.currentSessionId) return;
    const pending = this.pending.splice(0);
    this.pendingIds.clear();
    for (const message of pending) {
      this.persistAndSend({ ...message, sessionId: this.currentSessionId });
    }
  }

  /**
   * 日誌只是旁路：落庫失敗（SQLITE_BUSY、磁碟滿、clientId 衝突等）時降級為只轉發，
   * 不能讓異常沿 runtime 的 writer.send 往上拋而中斷整輪對話。
   */
  private persistAndSend(message: NormalizedMessage): void {
    try {
      this.persistAndSendOrThrow(message);
    } catch (error) {
      console.warn('[LoggingWriter] failed to persist message; forwarding without log', {
        sessionId: this.currentSessionId,
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.inner.send(message);
    }
  }

  private persistAndSendOrThrow(message: NormalizedMessage): void {
    if (!this.currentSessionId) return;
    const normalized = {
      ...message,
      sessionId: this.currentSessionId,
      provider: message.provider || this.provider,
    };

    if (normalized.kind === 'tool_result' && normalized.toolId) {
      const folded = sessionMessagesDb.foldToolResult(
        this.currentSessionId,
        truncateMessagePayload(normalized),
        truncateMessagePayload,
      );
      if (folded) {
        this.inner.send(folded);
        return;
      }
      normalized.id = `${normalized.toolId}:result`;
    }

    if (normalized.kind === 'text' && normalized.role === 'user' && normalized.id.startsWith('user:')) {
      const result = sessionMessagesDb.insertUserIfAbsent(
        this.currentSessionId,
        truncateMessagePayload(normalized),
        this.writerUserId,
      );
      if (result.status === 'conflict' || !result.message) {
        throw new Error('clientId conflicts with an existing session message');
      }
      this.inner.send(result.message);
      return;
    }

    const result = sessionMessagesDb.upsertById(
      this.currentSessionId,
      truncateMessagePayload(normalized),
      'live',
    );
    this.inner.send(result.message);
  }

  private sendInterruptedMarker(completeMessage: AnyRecord): void {
    if (this.interruptedSent) return;
    this.interruptedSent = true;
    if (!this.currentSessionId) return;
    const marker = truncateMessagePayload(createNormalizedMessage({
      id: `${this.currentSessionId}:interrupted:${this.runId}`,
      sessionId: this.currentSessionId,
      provider: typeof completeMessage.provider === 'string'
        ? completeMessage.provider as LLMProvider
        : this.provider,
      kind: 'text',
      role: 'user',
      content: '<turn_aborted>',
      isInterrupted: true,
    }));
    this.persistAndSend(marker);
  }
}

export function getLoggingWriterForSession(sessionId: string): LoggingWriter | null {
  return activeWriters.get(sessionId) ?? null;
}

export function isSessionLogActive(sessionId: string): boolean {
  return activeWriters.has(sessionId);
}

/**
 * Helper for dispatcher-owned persistent messages that do not originate inside
 * a provider runtime.
 */
export function sendToClient(writer: ProviderRuntimeWriter, message: unknown): void {
  if (writer instanceof LoggingWriter) {
    writer.send(message);
    return;
  }

  if (isRecord(message) && isPersistentMessage(message) && typeof message.sessionId === 'string') {
    const normalized = mergeRuntimeMessage(message, message.sessionId, message.provider);
    let result: NormalizedMessage | null = null;
    try {
      result = normalized.kind === 'tool_result' && normalized.toolId
        ? sessionMessagesDb.foldToolResult(
          normalized.sessionId,
          truncateMessagePayload(normalized),
          truncateMessagePayload,
        )
        : sessionMessagesDb.upsertById(normalized.sessionId, truncateMessagePayload(normalized), 'live').message;
    } catch (error) {
      console.warn('[LoggingWriter] failed to persist dispatcher message; forwarding without log', error);
    }
    writer.send(result || truncateMessagePayload(normalized));
    return;
  }
  writer.send(message);
}
