import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('session archive queries hide archived rows from active project views', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-active', 'claude', '/workspace/demo-project', 'Active Session');
    sessionsDb.createSession('session-archived', 'claude', '/workspace/demo-project', 'Archived Session');
    sessionsDb.updateSessionIsArchived('session-archived', true);

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const activeProjectSessions = sessionsDb.getSessionsByProjectPath('/workspace/demo-project');
    const allProjectSessions = sessionsDb.getSessionsByProjectPathIncludingArchived('/workspace/demo-project');

    assert.deepEqual(activeSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(archivedSessions.map((session) => session.session_id), ['session-archived']);
    assert.deepEqual(activeProjectSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(
      allProjectSessions.map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo-project'), 1);
  });
});

test('createSession reactivates archived rows when the session becomes active again', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.updateSessionIsArchived('session-reused', true);

    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const restoredSession = sessionsDb.getSessionById('session-reused');

    assert.equal(activeSessions.length, 1);
    assert.equal(activeSessions[0]?.session_id, 'session-reused');
    assert.equal(activeSessions[0]?.custom_name, 'Updated Name');
    assert.equal(archivedSessions.length, 0);
    assert.equal(restoredSession?.isArchived, 0);
  });
});

test('session model is stored independently of the sessions row and upserted', async () => {
  await withIsolatedDatabase(() => {
    // 新 session 在同步器建立 sessions 列之前就要能寫入
    assert.equal(sessionsDb.getSessionModel('session-new'), null);
    sessionsDb.setSessionModel('session-new', 'opus');
    assert.equal(sessionsDb.getSessionModel('session-new'), 'opus');

    sessionsDb.setSessionModel('session-new', 'anthropic/gpt-6-astra-hc-yd');
    assert.equal(sessionsDb.getSessionModel('session-new'), 'anthropic/gpt-6-astra-hc-yd');

    // 同步器之後建立 sessions 列，不影響已記錄的模型
    sessionsDb.createSession('session-new', 'claude', '/workspace/demo-project');
    assert.equal(sessionsDb.getSessionModel('session-new'), 'anthropic/gpt-6-astra-hc-yd');
  });
});

test('啟動遷移刪除 gemini 索引列，殘留的 gemini 收藏在讀取時被略過', async () => {
  const { getConnection } = await import('@/modules/database/connection.js');
  const { runMigrations } = await import('@/modules/database/migrations.js');
  const { getProjectsWithSessions } = await import('@/modules/projects/index.js');

  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('claude-1', 'claude', '/workspace/retired', 'Claude');
    sessionsDb.createSession('gemini-1', 'gemini', '/workspace/retired', 'Gemini');
    sessionsDb.updateSessionIsStarred('gemini-1', true);

    runMigrations(getConnection());
    assert.equal(sessionsDb.getSessionById('gemini-1'), null);
    assert.ok(sessionsDb.getSessionById('claude-1'));

    // 舊版程式在遷移後又寫入（或手動殘留）的 gemini 收藏：讀取不得崩潰，且不出現在任何 provider 分組
    sessionsDb.createSession('gemini-2', 'gemini', '/workspace/retired', 'Gemini again');
    sessionsDb.updateSessionIsStarred('gemini-2', true);
    const projects = await getProjectsWithSessions({ skipSynchronization: true });
    const project = projects.find((p) => p.fullPath === '/workspace/retired');
    assert.ok(project);
    assert.deepEqual(project.sessions.map((s) => s.id), ['claude-1']);
    assert.equal(JSON.stringify(projects).includes('gemini-2'), false);
  });
});
