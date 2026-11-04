import type { IProviderRuntime, ProviderRuntimeWriter } from '@/shared/interfaces.js';

import {
  abortCursorSession,
  getActiveCursorSessions,
  isCursorSessionActive,
  spawnCursor,
} from '../../../../cursor-cli.js';

/** Wraps server/cursor-cli.js. Cursor cannot re-attach a writer; reconnect only reports activity. */
export class CursorRuntimeProvider implements IProviderRuntime {
  async start(command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter): Promise<void> {
    await spawnCursor(command, options, writer);
  }

  async abort(sessionId: string): Promise<{ ok: boolean; emitsTerminal: boolean }> {
    return { ok: Boolean(abortCursorSession(sessionId)), emitsTerminal: false };
  }

  isActive(sessionId: string): boolean {
    return Boolean(isCursorSessionActive(sessionId));
  }

  reconnect(sessionId: string): boolean {
    return this.isActive(sessionId);
  }

  listActive(): unknown {
    return getActiveCursorSessions();
  }
}
