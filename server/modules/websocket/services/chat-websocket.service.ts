import crypto from 'node:crypto';

import type { WebSocket } from 'ws';

import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import {
  hasLiveShellSession,
  markShellSessionStale,
} from '@/modules/websocket/services/shell-websocket.service.js';
import { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import {
  getLoggingWriterForSession,
  LoggingWriter,
  sendToClient,
} from '@/modules/websocket/services/logging-writer.service.js';
import { isSessionMessageLogEnabled } from '@/shared/session-message-log-flags.js';
import { sessionsDb } from '@/modules/database/index.js';
import { expandSessionMentions } from '@/modules/providers/index.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';

type ChatIncomingMessage = AnyRecord & {
  type?: string;
  command?: string;
  options?: AnyRecord;
  provider?: string;
  sessionId?: string;
  requestId?: string;
  allow?: unknown;
  updatedInput?: unknown;
  message?: unknown;
  rememberEntry?: unknown;
  clientId?: string;
  afterSeq?: number;
};

const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 缺省時由伺服器補一個 clientId：部署後仍在跑快取舊前端（PWA）或其他不帶 clientId 的
 * 客戶端不能因此整個送不出訊息；帶了但格式不對才視為錯誤請求。
 */
function resolveClientId(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return crypto.randomUUID();
  if (typeof raw !== 'string' || !CLIENT_ID_PATTERN.test(raw)) {
    throw new Error('clientId must be a UUID');
  }
  return raw;
}

/**
 * 同一个 sessionId 如果同时被终端页的 `<cli> --resume` 进程和聊天页的 SDK
 * 打开，两个进程各自持有一份内存历史，又都往同一份 transcript 追加：终端页
 * 会永远停在启动那一刻的历史，记录本身也会分叉。
 *
 * 这里不拦截（在终端里看历史会话是正常用法），只做两件事：把终端标记为陈旧
 * 并在那边打警告，同时给聊天页回一条提示消息。
 */
function warnOnConcurrentShellSession(
  sessionId: unknown,
  provider: LLMProvider,
  writer: WebSocketWriter | LoggingWriter,
): void {
  if (typeof sessionId !== 'string' || !hasLiveShellSession(sessionId)) {
    return;
  }

  markShellSessionStale(sessionId);
  sendToClient(writer,
    createNormalizedMessage({
      kind: 'task_notification',
      provider,
      sessionId,
      status: 'warning',
      summary: `终端页正打开同一个会话（${sessionId}）。两边是独立进程，终端那侧的历史不会自动同步，继续在终端输入会造成记录分叉。`,
    }),
  );
}

type ProviderRegistryLike = {
  listProviders(): Array<{ id: LLMProvider; runtime: IProviderRuntime }>;
  resolveProvider(provider: string): { id: LLMProvider; runtime: IProviderRuntime };
};

type ChatWebSocketDependencies = {
  providerRegistry: ProviderRegistryLike;
  resolveCodexApproval: (requestId: string, userId: string | number | null, threadId: string, decision: unknown) => boolean;
  resolveToolApproval: (
    requestId: string,
    userId: string | number | null,
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
    }
  ) => boolean;
};

/** Resolves the payload's provider; an unknown or missing provider is a client error. */
function resolveRuntime(registry: ProviderRegistryLike, value: unknown): { id: LLMProvider; runtime: IProviderRuntime } {
  if (typeof value !== 'string' || !value) {
    throw new Error('provider is required');
  }
  return registry.resolveProvider(value);
}

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const writer = new WebSocketWriter(ws, readRequestUserId(request));

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as ChatIncomingMessage;
      const messageType = data.type;
      if (!messageType) {
        throw new Error('Message type is required');
      }

      const registry = dependencies.providerRegistry;

      if (messageType === 'chat-command') {
        const { id, runtime } = resolveRuntime(registry, data.provider);
        const clientId = resolveClientId(data.clientId);
        const requestedSessionId = typeof data.options?.sessionId === 'string'
          ? data.options.sessionId
          : null;
        const loggingWriter = new LoggingWriter(writer, {
          initialSessionId: requestedSessionId,
          userId: writer.userId,
          provider: id,
        });
        try {
          loggingWriter.recordUserMessage({
            clientId,
            content: data.command ?? '',
            images: data.options?.images,
            provider: id,
            sessionId: requestedSessionId,
          });
          // Codex hands the session over from the terminal itself (codex-session-handoff).
          if (id !== 'codex') {
            warnOnConcurrentShellSession(requestedSessionId, id, loggingWriter);
          }
          // 日志里记用户原文（含 @session:<id>），送给 agent 的才展开成 transcript 引用
          const cwd = typeof data.options?.cwd === 'string' ? data.options.cwd : null;
          const command = await expandSessionMentions(data.command ?? '', cwd);
          await runtime.start(command, data.options ?? {}, loggingWriter);
        } finally {
          loggingWriter.finish();
        }
        return;
      }

      if (messageType === 'abort-session') {
        const { id, runtime } = resolveRuntime(registry, data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const registered = getLoggingWriterForSession(sessionId);
        const loggingWriter = registered
          ?? new LoggingWriter(writer, {
            initialSessionId: sessionId,
            userId: writer.userId,
            provider: id,
          });
        try {
          const { ok, emitsTerminal } = await runtime.abort(sessionId, loggingWriter);
          // 每次中斷只有一個終止事件：emitsTerminal 的 runtime（Codex、Antigravity）自己送；
          // 其他 runtime（Claude、Cursor）由這裡立即送出，底層在中斷後會略過自己的 complete/error。
          if (ok && emitsTerminal) return;
          sendToClient(loggingWriter,
            createNormalizedMessage({
              kind: 'complete',
              exitCode: ok ? 0 : 1,
              aborted: true,
              success: ok,
              sessionId,
              provider: id,
            })
          );
        } finally {
          if (!registered) loggingWriter.finish();
        }
        return;
      }

      if (messageType === 'chat-steer') {
        const { id, runtime } = resolveRuntime(registry, data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const text = typeof data.text === 'string' ? data.text : '';
        const clientId = resolveClientId(data.clientId);
        const steerText = await expandSessionMentions(
          text,
          sessionsDb.getSessionById(sessionId)?.project_path ?? null,
        );
        const result = runtime.steer
          ? await runtime.steer(sessionId, writer.userId, steerText)
          : { ok: false, reason: 'unsupported' };
        if (result.ok) {
          const registeredWriter = getLoggingWriterForSession(sessionId);
          const loggingWriter = registeredWriter
            ?? new LoggingWriter(writer, {
              initialSessionId: sessionId,
              userId: writer.userId,
              provider: id,
            });
          try {
            loggingWriter.recordUserMessage({
              clientId,
              content: text,
              provider: id,
              sessionId,
            });
          } finally {
            if (!registeredWriter) loggingWriter.finish();
          }
        }
        // clientId 原樣回傳，前端據此對應是哪一次送出
        sendToClient(writer, {
          type: result.ok ? 'steer-accepted' : 'steer-rejected',
          provider: id,
          sessionId,
          clientId: data.clientId ?? null,
          text,
          ...(result.ok ? {} : { reason: result.reason ?? 'rejected' }),
        });
        return;
      }

      if (messageType === 'codex-permission-response') {
        const ok = dependencies.resolveCodexApproval(String(data.requestId || ''), writer.userId,
          String(data.sessionId || ''), data.decision);
        if (!ok) sendToClient(writer, createNormalizedMessage({ kind: 'task_notification', provider: 'codex',
          sessionId: String(data.sessionId || ''), status: 'warning', summary: 'Approval is no longer valid or does not belong to this session.' }));
        return;
      }

      if (messageType === 'claude-permission-response') {
        if (typeof data.requestId === 'string' && data.requestId.length > 0) {
          const ok = dependencies.resolveToolApproval(data.requestId, writer.userId, {
            allow: Boolean(data.allow),
            updatedInput: data.updatedInput,
            message: typeof data.message === 'string' ? data.message : undefined,
            rememberEntry: data.rememberEntry,
          });
          if (!ok) sendToClient(writer, createNormalizedMessage({ kind: 'task_notification', provider: 'claude',
            sessionId: typeof data.sessionId === 'string' ? data.sessionId : null, status: 'warning',
            summary: 'Approval is no longer valid or does not belong to this session.' }));
        }
        return;
      }

      if (messageType === 'check-session-status') {
        const { id, runtime } = resolveRuntime(registry, data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const registered = getLoggingWriterForSession(sessionId);
        const afterSeq = typeof data.afterSeq === 'number' && Number.isFinite(data.afterSeq)
          ? data.afterSeq
          : null;
        // 關閉日誌讀路徑時前端走舊合併邏輯，重播的日誌行（user:<uuid> 等 id）會與 provider 歷史重複
        const replayEnabled = isSessionMessageLogEnabled();
        if (registered) {
          registered.updateWebSocket(writer.ws);
          if (replayEnabled) registered.replayAfterSeq(afterSeq);
        } else if (sessionId && replayEnabled) {
          const tempWriter = new LoggingWriter(writer, {
            initialSessionId: sessionId,
            userId: writer.userId,
            provider: id,
          });
          try {
            tempWriter.replayAfterSeq(afterSeq);
          } finally {
            tempWriter.finish();
          }
        }
        const isProcessing = runtime.reconnect(sessionId, registered ?? writer);
        writer.send({
          type: 'session-status',
          sessionId,
          provider: id,
          isProcessing,
        });
        return;
      }

      if (messageType === 'get-pending-permissions') {
        // 帶 sessionId：只回該會話；不帶：跨所有活躍會話匯總（全域待審批池，design D16）。
        // 各 runtime 只回傳呼叫者自己的項目。
        const sessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : undefined;
        writer.send({
          type: 'pending-permissions-response',
          ...(sessionId ? { sessionId } : {}),
          data: registry.listProviders().flatMap(({ id, runtime }) =>
            (runtime.getPendingApprovals?.(writer.userId, sessionId) ?? []).map((item) => ({ provider: id, ...item }))),
        });
        return;
      }

      if (messageType === 'get-active-sessions') {
        writer.send({
          type: 'active-sessions',
          sessions: Object.fromEntries(
            registry.listProviders().map(({ id, runtime }) => [id, runtime.listActive()]),
          ),
        });
        return;
      }

      throw new Error(`Unknown message type: ${messageType}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      writer.send({
        type: 'error',
        error: message,
      });
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
