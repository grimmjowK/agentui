import type { WebSocket } from 'ws';

import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import {
  hasLiveShellSession,
  markShellSessionStale,
} from '@/modules/websocket/services/shell-websocket.service.js';
import { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
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
};

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
  writer: WebSocketWriter,
): void {
  if (typeof sessionId !== 'string' || !hasLiveShellSession(sessionId)) {
    return;
  }

  markShellSessionStale(sessionId);
  writer.send(
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
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
    }
  ) => void;
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
        // Codex hands the session over from the terminal itself (codex-session-handoff).
        if (id !== 'codex') {
          warnOnConcurrentShellSession(data.options?.sessionId, id, writer);
        }
        await runtime.start(data.command ?? '', data.options ?? {}, writer);
        return;
      }

      if (messageType === 'abort-session') {
        const { id, runtime } = resolveRuntime(registry, data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const { ok, emitsTerminal } = await runtime.abort(sessionId, writer);
        // Exactly one terminal event per abort: skip ours when the runtime sends its own.
        if (ok && emitsTerminal) return;
        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: ok ? 0 : 1,
            aborted: true,
            success: ok,
            sessionId,
            provider: id,
          })
        );
        return;
      }

      if (messageType === 'chat-steer') {
        const { id, runtime } = resolveRuntime(registry, data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const text = typeof data.text === 'string' ? data.text : '';
        const result = runtime.steer
          ? await runtime.steer(sessionId, writer.userId, text)
          : { ok: false, reason: 'unsupported' };
        // clientId 原樣回傳，前端據此對應是哪一次送出
        writer.send({
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
        if (!ok) writer.send(createNormalizedMessage({ kind: 'task_notification', provider: 'codex',
          sessionId: String(data.sessionId || ''), status: 'warning', summary: 'Approval is no longer valid or does not belong to this session.' }));
        return;
      }

      if (messageType === 'claude-permission-response') {
        if (typeof data.requestId === 'string' && data.requestId.length > 0) {
          dependencies.resolveToolApproval(data.requestId, {
            allow: Boolean(data.allow),
            updatedInput: data.updatedInput,
            message: typeof data.message === 'string' ? data.message : undefined,
            rememberEntry: data.rememberEntry,
          });
        }
        return;
      }

      if (messageType === 'check-session-status') {
        const { id, runtime } = resolveRuntime(registry, data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        writer.send({
          type: 'session-status',
          sessionId,
          provider: id,
          isProcessing: runtime.reconnect(sessionId, writer),
        });
        return;
      }

      if (messageType === 'get-pending-permissions') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        if (!sessionId) return;
        const sources = registry.listProviders()
          .filter(({ runtime }) => runtime.getPendingApprovals && runtime.isActive(sessionId));
        // Only answer when a provider owns this live session; an empty reply would
        // wipe approvals other providers replay through their realtime stream.
        if (sources.length === 0) return;
        writer.send({
          type: 'pending-permissions-response',
          sessionId,
          data: sources.flatMap(({ runtime }) => runtime.getPendingApprovals?.(writer.userId, sessionId) ?? []),
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
