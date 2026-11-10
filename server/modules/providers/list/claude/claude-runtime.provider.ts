import type { IProviderRuntime, PendingApprovalItem, ProviderRuntimeWriter } from '@/shared/interfaces.js';

import {
  abortClaudeSDKSession,
  getActiveClaudeSDKSessions,
  getPendingApprovals,
  isClaudeSDKSessionActive,
  queryClaudeSDK,
  reconnectSessionWriter,
  steerClaudeSDKSession,
} from '../../../../claude-sdk.js';

/** Wraps server/claude-sdk.js. 中斷的終止事件由 dispatcher 送出；claude-sdk 在中斷後略過自己的 complete/error。 */
export class ClaudeRuntimeProvider implements IProviderRuntime {
  async start(command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter): Promise<void> {
    await queryClaudeSDK(command, options, writer);
  }

  async abort(sessionId: string): Promise<{ ok: boolean; emitsTerminal: boolean }> {
    return { ok: Boolean(await abortClaudeSDKSession(sessionId)), emitsTerminal: false };
  }

  steer(sessionId: string, userId: string | number | null, text: string): Promise<{ ok: boolean; reason?: string }> {
    return steerClaudeSDKSession(sessionId, userId, text);
  }

  isActive(sessionId: string): boolean {
    return Boolean(isClaudeSDKSessionActive(sessionId));
  }

  reconnect(sessionId: string, writer: ProviderRuntimeWriter): boolean {
    if (!this.isActive(sessionId)) return false;
    // claude-sdk swaps the raw socket inside its existing writer.
    if (writer.ws) reconnectSessionWriter(sessionId, writer.ws);
    return true;
  }

  listActive(): unknown {
    return getActiveClaudeSDKSessions();
  }

  getPendingApprovals(userId: string | number | null, sessionId?: string): PendingApprovalItem[] {
    return getPendingApprovals(userId, sessionId) as PendingApprovalItem[];
  }
}
