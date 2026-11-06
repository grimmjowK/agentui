import { getConnection } from '@/modules/database/connection.js';
import type { LLMProvider } from '@/shared/types.js';

type ValueRow = { value: string | null };

const cursorKey = (provider: LLMProvider) => `scan_cursor:${provider}`;

/** SQLite CURRENT_TIMESTAMP-style UTC "YYYY-MM-DD HH:MM:SS" → Date. */
function parseSqliteTimestamp(value: string | null | undefined): Date | null {
  return value ? new Date(value.replace(' ', 'T') + 'Z') : null;
}

/**
 * 首次讀取某 provider 的游標時，以舊的全域值初始化（design D4）：
 * antigravity 沿用自己的 antigravity_last_scanned_at，其他 provider 沿用 scan_state。
 */
function readLegacyCursor(provider: LLMProvider): string | null {
  const db = getConnection();
  const row = provider === 'antigravity'
    ? db.prepare("SELECT value FROM app_config WHERE key = 'antigravity_last_scanned_at'").get() as ValueRow | undefined
    : db.prepare('SELECT last_scanned_at AS value FROM scan_state WHERE id = 1').get() as ValueRow | undefined;
  return row?.value ?? null;
}

/** Per-provider session scan cursors stored in app_config as `scan_cursor:<providerId>`. */
export const scanStateDb = {
  getLastScannedAt(provider: LLMProvider): Date | null {
    const row = getConnection()
      .prepare('SELECT value FROM app_config WHERE key = ?')
      .get(cursorKey(provider)) as ValueRow | undefined;
    return parseSqliteTimestamp(row ? row.value : readLegacyCursor(provider));
  },

  updateLastScannedAt(scannedAt: Date, provider: LLMProvider): void {
    const sqliteTimestamp = scannedAt.toISOString().slice(0, 19).replace('T', ' ');
    getConnection()
      .prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(cursorKey(provider), sqliteTimestamp);
  },
};
