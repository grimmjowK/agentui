import { getConnection } from '@/modules/database/connection.js';

type ScanStateRow = {
  last_scanned_at: string;
};

export const scanStateDb = {
    getLastScannedAt(provider: 'global' | 'antigravity' = 'global') {
        const db = getConnection();
        const row = provider === 'antigravity'
            ? db.prepare("SELECT value AS last_scanned_at FROM app_config WHERE key = 'antigravity_last_scanned_at'").get() as ScanStateRow | undefined
            : db.prepare('SELECT last_scanned_at FROM scan_state WHERE id = 1').get() as ScanStateRow | undefined;

        if (!row) {
            return null; // Before any scan, the row is undefined.
        }

        let lastScannedDate: Date | null = null;
        const lastScannedStr = row.last_scanned_at;

        if (lastScannedStr) {
            // SQLite CURRENT_TIMESTAMP returns UTC in "YYYY-MM-DD HH:MM:SS" format.
            // Replace space with 'T' and append 'Z' to parse reliably in JS across all platforms.
            lastScannedDate = new Date(lastScannedStr.replace(' ', 'T') + 'Z');
        }

        return lastScannedDate;
    },

    updateLastScannedAt(scannedAt: Date = new Date(), provider: 'global' | 'antigravity' = 'global') {
        const db = getConnection();
        const sqliteTimestamp = scannedAt.toISOString().slice(0, 19).replace('T', ' ');

        if (provider === 'antigravity') {
            db.prepare("INSERT INTO app_config (key, value) VALUES ('antigravity_last_scanned_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .run(sqliteTimestamp);
            return;
        }

        db.prepare(`
            INSERT INTO scan_state (id, last_scanned_at)
            VALUES (1, ?)
            ON CONFLICT (id)
            DO UPDATE SET last_scanned_at = excluded.last_scanned_at
        `).run(sqliteTimestamp);
    }
};
