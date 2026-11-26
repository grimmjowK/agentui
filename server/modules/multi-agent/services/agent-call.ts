/**
 * 一次 provider runtime 呼叫的封裝：收集輸出、追蹤 sessionId、支援中止與超時。
 * 工作流節點與聊天室成員共用（multi-agent-workspace design D5/D6）。
 */
import { randomUUID } from 'node:crypto';

import { providerRegistry } from '@/modules/providers/index.js';
import { LoggingWriter, sendToUser } from '@/modules/websocket/index.js';
import type { IProviderRuntime, ProviderRuntimeWriter } from '@/shared/interfaces.js';

import { PROVIDER_INFO, type LLMProvider, type PermissionMode } from '../../../../shared/providers.js';

export type AgentCallOptions = {
  userId: string | number;
  provider: LLMProvider;
  model: string;
  permissionMode: PermissionMode;
  cwd: string;
  sessionId: string | null;
  prompt: string;
  /** 不含等待審批時間的執行上限；未設定則不限 */
  timeoutMs?: number;
  /** 輸出變化時回傳目前完整文字 */
  onOutput?: (text: string) => void;
  /** 有任何事件時呼叫（用於進度） */
  onEvent?: () => void;
  /** 審批狀態變化 */
  onApprovalChange?: (waiting: boolean) => void;
  onSessionId?: (sessionId: string) => void;
  /**
   * 寫進會話訊息紀錄並推給使用者所有連線（工作流節點，node-live-session D1）。
   * 聊天頁打開該會話時看得到工具調用、串流與審批。
   */
  persist?: boolean;
};

export type AgentCallResult = {
  status: 'succeeded' | 'failed' | 'aborted' | 'timeout';
  sessionId: string | null;
  text: string;
  error: string | null;
};

export type RuntimeResolver = (provider: LLMProvider) => IProviderRuntime;

const defaultResolver: RuntimeResolver = (provider) => providerRegistry.resolveProvider(provider).runtime;

/** 計時器間隔，測試可調小 */
export const agentCallTiming = { tickMs: 1000 };

type Event = Record<string, unknown> & { kind?: string };

export class AgentCall {
  sessionId: string | null;
  private readonly completed: string[] = [];
  private segment = '';
  private error: string | null = null;
  private aborted = false;
  private timedOut = false;
  private abortRequested = false;
  private exitFailed = false;
  private readonly waiting = new Set<string>();
  private readonly runtime: IProviderRuntime;
  private readonly writer: ProviderRuntimeWriter;
  private rounds = 0;
  /** 目前這一輪實際交給 runtime 的 writer（persist 時是 LoggingWriter） */
  private activeWriter: ProviderRuntimeWriter | null = null;

  constructor(private readonly options: AgentCallOptions, resolveRuntime: RuntimeResolver = defaultResolver) {
    this.sessionId = options.sessionId;
    this.runtime = resolveRuntime(options.provider);
    this.writer = {
      userId: options.userId,
      send: (data) => this.handle(data),
      setSessionId: (id) => this.captureSessionId(id),
    };
  }

  get text(): string {
    // 只取目前串流段落或最後一個非空段落，過濾工具調用前的過場白與舊輪次輸出
    return this.segment || this.completed.at(-1) || '';
  }

  /**
   * 執行一輪。prompt 省略時用建構時的提示；之後的輪次（中斷後續接）以同一 sessionId 續接，
   * 輸出以最新一輪的最終回覆為準。clientId 用於前端對應樂觀顯示的使用者訊息。
   */
  async run(
    prompt = this.options.prompt,
    clientId: string = randomUUID(),
    images?: unknown,
    overrides?: { permissionMode?: PermissionMode; model?: string },
  ): Promise<AgentCallResult> {
    const { provider } = this.options;
    const permissionMode = overrides?.permissionMode ?? this.options.permissionMode;
    const model = overrides?.model ?? this.options.model;
    // 前一輪被中斷時殘留的串流段落，併入已完成的輸出
    if (this.segment) { this.completed.push(this.segment); this.segment = ''; }
    this.aborted = false;
    this.timedOut = false;
    this.error = null;
    this.exitFailed = false;
    const resume = this.rounds > 0 ? true : Boolean(this.options.sessionId);
    this.rounds += 1;
    const writer = this.options.persist ? this.createLoggingWriter(prompt, clientId, images) : this.writer;
    this.activeWriter = writer;
    const info = PROVIDER_INFO[provider];
    const mode = info.mapPermissionMode ? info.mapPermissionMode(permissionMode) : permissionMode;
    let elapsed = 0;
    const timer = this.options.timeoutMs
      ? setInterval(() => {
        if (this.waiting.size) return;
        elapsed += agentCallTiming.tickMs;
        if (elapsed >= this.options.timeoutMs! && !this.timedOut) {
          this.timedOut = true;
          void this.abort();
        }
      }, agentCallTiming.tickMs)
      : null;
    try {
      await this.runtime.start(prompt, {
        cwd: this.options.cwd,
        projectPath: this.options.cwd,
        sessionId: this.sessionId,
        resume,
        model,
        permissionMode: mode,
        // Cursor 只認 skipPermissions
        skipPermissions: mode === 'bypassPermissions',
        ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
      }, writer);
    } catch (error) {
      this.error ??= error instanceof Error ? error.message : String(error);
    } finally {
      if (timer) clearInterval(timer);
      if (writer instanceof LoggingWriter) writer.finish();
      this.activeWriter = null;
    }
    const status = this.timedOut ? 'timeout'
      : this.aborted ? 'aborted'
        : this.error || this.exitFailed ? 'failed'
          : 'succeeded';
    return { status, sessionId: this.sessionId, text: this.text, error: this.error };
  }

  /** LoggingWriter(inner = 扇出)：執行器自己處理事件，同時推給使用者所有連線 */
  private createLoggingWriter(prompt: string, clientId: string, images?: unknown): LoggingWriter {
    const { userId, provider } = this.options;
    const fanout: ProviderRuntimeWriter = {
      userId,
      send: (data) => {
        this.handle(data);
        // session_created 不推：停在「新會話」頁的聊天頁會把它當成自己的新會話而跳轉
        if ((data as Event | null)?.kind !== 'session_created') sendToUser(userId, data);
      },
      setSessionId: (id) => this.captureSessionId(id),
    };
    const writer = new LoggingWriter(fanout, { initialSessionId: this.sessionId, userId, provider });
    writer.recordUserMessage({ clientId, content: prompt, images, provider, sessionId: this.sessionId });
    return writer;
  }

  /** 中止。尚未取得 sessionId 時延後到取得後再中止。 */
  async abort(): Promise<void> {
    this.aborted = true;
    if (!this.sessionId) {
      this.abortRequested = true;
      return;
    }
    try {
      await this.runtime.abort(this.sessionId, this.activeWriter ?? this.writer);
    } catch (error) {
      console.warn('[multi-agent] abort failed', error);
    }
  }

  private captureSessionId(id: unknown): void {
    if (typeof id !== 'string' || !id || this.sessionId === id) return;
    this.sessionId = id;
    this.options.onSessionId?.(id);
    if (this.abortRequested) {
      this.abortRequested = false;
      void this.abort();
    }
  }

  private handle(raw: unknown): void {
    let event: Event | null = null;
    if (typeof raw === 'string') {
      try { event = JSON.parse(raw) as Event; } catch { return; }
    } else if (raw && typeof raw === 'object') {
      event = raw as Event;
    }
    if (!event) return;

    if (event.kind === 'session_created') this.captureSessionId(event.newSessionId);
    else if (typeof event.sessionId === 'string') this.captureSessionId(event.sessionId);

    switch (event.kind) {
      case 'permission_request':
        if (typeof event.requestId === 'string') this.setWaiting(event.requestId, true);
        // 轉推給使用者，全域審批池才看得到（persist 時扇出已經推送）
        if (!this.options.persist) sendToUser(this.options.userId, { ...event, provider: event.provider ?? this.options.provider });
        break;
      case 'permission_cancelled':
        if (typeof event.requestId === 'string') this.setWaiting(event.requestId, false);
        if (!this.options.persist) sendToUser(this.options.userId, event);
        break;
      case 'stream_delta':
        if (typeof event.content === 'string' && !this.aborted) {
          this.clearWaiting();
          this.segment += event.content;
          this.options.onOutput?.(this.text);
        }
        break;
      case 'text':
        if (event.role === 'assistant' && typeof event.content === 'string' && !this.aborted) {
          this.clearWaiting();
          if (event.content.trim()) this.completed.push(event.content);
          this.segment = '';
          this.options.onOutput?.(this.text);
        }
        break;
      case 'tool_use':
      case 'tool_result':
        this.clearWaiting();
        break;
      case 'error':
        this.error = typeof event.content === 'string' && event.content ? event.content : 'Unknown error';
        break;
      case 'complete':
        // 由外部（聊天頁停止）中斷時，執行器也要知道這一輪是被中斷的
        if (event.aborted === true) this.aborted = true;
        if (typeof event.exitCode === 'number' && event.exitCode !== 0 && !event.aborted) this.exitFailed = true;
        if (typeof event.actualSessionId === 'string') this.captureSessionId(event.actualSessionId);
        break;
      default:
        break;
    }
    this.options.onEvent?.();
  }

  private setWaiting(requestId: string, waiting: boolean): void {
    const before = this.waiting.size > 0;
    if (waiting) this.waiting.add(requestId);
    else this.waiting.delete(requestId);
    if (before !== this.waiting.size > 0) this.options.onApprovalChange?.(this.waiting.size > 0);
  }

  private clearWaiting(): void {
    if (!this.waiting.size) return;
    this.waiting.clear();
    this.options.onApprovalChange?.(false);
  }
}

/** 依 Unicode code point 截斷，含結尾「…」不超過 max。回傳 null 表示未超出。 */
export function truncateCodePoints(text: string, max: number): string | null {
  const chars = [...text];
  if (chars.length <= max) return null;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** 從最新往回取，合計不超過 maxChars code points。回傳是否有截斷。 */
export function takeRecentWithin<T>(items: T[], size: (item: T) => number, maxItems: number, maxChars: number): { items: T[]; truncated: boolean } {
  const picked: T[] = [];
  let total = 0;
  for (let i = items.length - 1; i >= 0 && picked.length < maxItems; i--) {
    const n = size(items[i]);
    if (total + n > maxChars) break;
    total += n;
    picked.unshift(items[i]);
  }
  return { items: picked, truncated: picked.length < items.length };
}
