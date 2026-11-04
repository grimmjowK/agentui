import type { IProviderRuntime, ProviderRuntimeWriter } from '@/shared/interfaces.js';

import {
  abortAntigravitySession,
  getActiveAntigravitySessions,
  isAntigravitySessionActive,
  reconnectAntigravitySession,
  spawnAntigravity,
} from '../../../../antigravity-cli.js';

/** Wraps server/antigravity-cli.js. The runtime emits completion after the process exits. */
export class AntigravityRuntimeProvider implements IProviderRuntime {
  async start(command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter): Promise<void> {
    await spawnAntigravity(command, options, writer);
  }

  async abort(sessionId: string): Promise<{ ok: boolean; emitsTerminal: boolean }> {
    return { ok: Boolean(abortAntigravitySession(sessionId)), emitsTerminal: true };
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
