import type { IProviderRuntime, ProviderRuntimeWriter } from '@/shared/interfaces.js';

import {
  abortCodexSession,
  getActiveCodexSessions,
  isCodexSessionActive,
  queryCodex,
  reconnectCodexSession,
} from '../../../../openai-codex.js';

/** Wraps server/openai-codex.js. The runtime emits its own terminal event after an abort. */
export class CodexRuntimeProvider implements IProviderRuntime {
  async start(command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter): Promise<void> {
    await queryCodex(command, options, writer);
  }

  async abort(sessionId: string, writer: ProviderRuntimeWriter): Promise<{ ok: boolean; emitsTerminal: boolean }> {
    // Re-attach first so the cancellation terminal event reaches the requesting client
    // (also verifies the caller owns the run).
    const ok = this.reconnect(sessionId, writer) && Boolean(abortCodexSession(sessionId));
    return { ok, emitsTerminal: true };
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
}
