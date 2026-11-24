import type { IProviderRuntime, PendingApprovalItem, ProviderRuntimeWriter } from '@/shared/interfaces.js';
import { workflowSessions } from '@/shared/workflow-session-registry.js';

import {
  abortCodexSession,
  getActiveCodexSessions,
  isCodexSessionActive,
  listPendingCodexApprovals,
  queryCodex,
  reconnectCodexSession,
  steerCodexSession,
} from '../../../../openai-codex.js';

/** Wraps server/openai-codex.ts. The runtime emits its own terminal event after an abort. */
export class CodexRuntimeProvider implements IProviderRuntime {
  async start(command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter): Promise<void> {
    await queryCodex(command, options, writer);
  }

  async abort(sessionId: string, writer: ProviderRuntimeWriter): Promise<{ ok: boolean; emitsTerminal: boolean }> {
    // 工作流節點執行中由 AgentCall 的 fanout writer 持有，不可 reconnect 搶占
    if (workflowSessions.get(sessionId)) {
      const uid = writer.userId === null ? undefined : writer.userId;
      const ok = Boolean(abortCodexSession(sessionId, uid));
      return { ok, emitsTerminal: true };
    }
    // Re-attach first so the cancellation terminal event reaches the requesting client
    // (also verifies the caller owns the run).
    const ok = this.reconnect(sessionId, writer) && Boolean(abortCodexSession(sessionId));
    return { ok, emitsTerminal: true };
  }

  steer(sessionId: string, userId: string | number | null, text: string): Promise<{ ok: boolean; reason?: string }> {
    return steerCodexSession(sessionId, userId, text);
  }

  isActive(sessionId: string): boolean {
    return Boolean(isCodexSessionActive(sessionId));
  }

  reconnect(sessionId: string, writer: ProviderRuntimeWriter): boolean {
    return Boolean(reconnectCodexSession(sessionId, writer));
  }

  listActive(): unknown {
    return getActiveCodexSessions();
  }

  getPendingApprovals(userId: string | number | null, sessionId?: string): PendingApprovalItem[] {
    return listPendingCodexApprovals(userId, sessionId);
  }
}
