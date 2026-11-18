import type { IProviderRuntime, PendingApprovalItem, ProviderRuntimeWriter } from '@/shared/interfaces.js';

import {
  abortAntigravitySession,
  getActiveAntigravitySessions,
  isAntigravitySessionActive,
  reconnectAntigravitySession,
  spawnAntigravity,
  steerAntigravitySession,
} from '../../../../antigravity-cli.js';

import { antigravityApprovals } from './antigravity-approvals.js';

/** Wraps server/antigravity-cli.js（ACP）。中斷的終止事件由執行層在 prompt 返回後送出。 */
export class AntigravityRuntimeProvider implements IProviderRuntime {
  async start(command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter): Promise<void> {
    await spawnAntigravity(command, options, writer);
  }

  async abort(sessionId: string): Promise<{ ok: boolean; emitsTerminal: boolean }> {
    return { ok: Boolean(abortAntigravitySession(sessionId)), emitsTerminal: true };
  }

  async steer(sessionId: string, userId: string | number | null, text: string): Promise<{ ok: boolean; reason?: string }> {
    return steerAntigravitySession(sessionId, userId, text);
  }

  getPendingApprovals(userId: string | number | null, sessionId?: string): PendingApprovalItem[] {
    return antigravityApprovals.list(userId, sessionId);
  }

  resolveApproval(requestId: string, userId: string | number | null, decision: unknown): boolean {
    return antigravityApprovals.decide(requestId, userId, decision);
  }

  isActive(sessionId: string): boolean {
    return Boolean(isAntigravitySessionActive(sessionId));
  }

  reconnect(sessionId: string, writer: ProviderRuntimeWriter): boolean {
    return Boolean(reconnectAntigravitySession(sessionId, writer));
  }

  listActive(): unknown {
    return getActiveAntigravitySessions();
  }
}
