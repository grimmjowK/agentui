import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { ensureAntigravitySessionInCliStore } from './antigravity-session-store.js';

function createConversationDatabase(filePath: string, message: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const database = new Database(filePath);
  database.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, content TEXT NOT NULL)');
  database.prepare(
    'INSERT INTO steps VALUES (?, ?) ON CONFLICT(idx) DO UPDATE SET content = excluded.content',
  ).run(1, message);
  database.close();
}

test('imports a legacy conversation into the CLI store once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-session-store-'));
  const sessionId = 'legacy-session';
  const legacyRoot = path.join(root, '.gemini', 'antigravity');
  const cliRoot = path.join(root, '.gemini', 'antigravity-cli');
  const sourcePath = path.join(legacyRoot, 'conversations', `${sessionId}.db`);
  const destinationPath = path.join(cliRoot, 'conversations', `${sessionId}.db`);

  try {
    createConversationDatabase(sourcePath, 'restored history');

    assert.equal(
      await ensureAntigravitySessionInCliStore(sessionId, { homeDir: root, cliRoot }),
      true,
    );

    const restored = new Database(destinationPath, { readonly: true });
    assert.equal(
      restored.prepare('SELECT content FROM steps WHERE idx = 1').pluck().get(),
      'restored history',
    );
    restored.close();

    createConversationDatabase(sourcePath, 'changed source');
    assert.equal(
      await ensureAntigravitySessionInCliStore(sessionId, { homeDir: root, cliRoot }),
      false,
    );

    const unchanged = new Database(destinationPath, { readonly: true });
    assert.equal(
      unchanged.prepare('SELECT content FROM steps WHERE idx = 1').pluck().get(),
      'restored history',
    );
    unchanged.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unsafe conversation IDs', async () => {
  await assert.rejects(
    ensureAntigravitySessionInCliStore('../outside'),
    /Invalid Antigravity conversation ID/,
  );
});

test('captures committed WAL data while the source database is active', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-session-wal-'));
  const sessionId = 'active-session';
  const sourcePath = path.join(
    root,
    '.gemini',
    'antigravity',
    'conversations',
    `${sessionId}.db`,
  );
  const cliRoot = path.join(root, '.gemini', 'antigravity-cli');
  const destinationPath = path.join(cliRoot, 'conversations', `${sessionId}.db`);
  let source: Database.Database | undefined;

  try {
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    source = new Database(sourcePath);
    source.pragma('journal_mode = WAL');
    source.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, content TEXT NOT NULL)');
    source.prepare('INSERT INTO steps VALUES (?, ?)').run(1, 'committed WAL data');

    assert.equal(
      await ensureAntigravitySessionInCliStore(sessionId, { homeDir: root, cliRoot }),
      true,
    );

    const restored = new Database(destinationPath, { readonly: true });
    assert.equal(
      restored.prepare('SELECT content FROM steps WHERE idx = 1').pluck().get(),
      'committed WAL data',
    );
    restored.close();
  } finally {
    source?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
