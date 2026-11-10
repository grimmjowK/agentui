import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appConfigDb,
  getConnection,
  initializeDatabase,
  scanStateDb,
} from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import type { IProvider } from '@/shared/interfaces.js';

// node --test 每個檔案一個行程：在第一次連線前指定獨立的資料庫即可隔離。
process.env.DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'sync-cursor-')), 'auth.db');

test('首次讀取時以舊的 antigravity 游標初始化', async () => {
  await initializeDatabase();
  appConfigDb.set('antigravity_last_scanned_at', '2026-03-04 05:06:07');
  assert.equal(scanStateDb.getLastScannedAt('antigravity')?.toISOString(), '2026-03-04T05:06:07.000Z');
});

test('原生標題升級遷移只重設一次 Antigravity 全量掃描游標', async () => {
  await initializeDatabase();
  const db = getConnection();
  const migrationKey = 'migration:antigravity-native-title-rescan:v1';
  db.prepare('DELETE FROM app_config WHERE key = ?')
    .run(migrationKey);
  appConfigDb.set('scan_cursor:antigravity', '2026-03-04 05:06:07');
  appConfigDb.set('antigravity_last_scanned_at', '2026-02-01 00:00:00');

  await initializeDatabase();

  assert.equal(scanStateDb.getLastScannedAt('antigravity'), null);
  assert.equal(appConfigDb.get(migrationKey), '1');

  scanStateDb.updateLastScannedAt(new Date('2026-04-01T00:00:00Z'), 'antigravity');
  await initializeDatabase();
  assert.equal(scanStateDb.getLastScannedAt('antigravity')?.toISOString(), '2026-04-01T00:00:00.000Z');
});

test('一個 provider 同步失敗時，其他 provider 照常推進各自的游標', async (t) => {
  await initializeDatabase();
  const sinceByProvider: Record<string, Date | undefined> = {};
  const fakeProvider = (id: IProvider['id'], fail: boolean) => ({
    id,
    sessionSynchronizer: {
      synchronize: async (since?: Date) => {
        sinceByProvider[id] = since;
        if (fail) throw new Error('disk unreadable');
        return 3;
      },
      synchronizeFile: async () => null,
    },
  }) as unknown as IProvider;
  t.mock.method(providerRegistry, 'listProviders', () => [fakeProvider('claude', false), fakeProvider('codex', true)]);

  const old = new Date('2026-01-01T00:00:00Z');
  scanStateDb.updateLastScannedAt(old, 'claude');
  scanStateDb.updateLastScannedAt(old, 'codex');

  const result = await sessionSynchronizerService.synchronizeSessions();

  assert.deepEqual(result.processedByProvider, { claude: 3 });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /^codex: disk unreadable/);
  assert.deepEqual(sinceByProvider.claude, old);
  assert.ok(scanStateDb.getLastScannedAt('claude')!.getTime() > old.getTime(), 'claude 游標應前進');
  assert.deepEqual(scanStateDb.getLastScannedAt('codex'), old, 'codex 游標應停在原處');
});
