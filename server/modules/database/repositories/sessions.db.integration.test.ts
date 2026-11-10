import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { sessionMessagesDb } from '@/modules/database/repositories/session-messages.db.js';
import { shouldKeepExistingSessionName } from '@/shared/utils.js';

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

test('hard-deleting a project removes all of its session messages without orphans', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('project-session-1', 'claude', '/workspace/to-delete');
    sessionsDb.createSession('project-session-2', 'codex', '/workspace/to-delete');
    sessionMessagesDb.append('project-session-1', {
      id: 'm1',
      sessionId: 'project-session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'one',
    });
    sessionMessagesDb.append('project-session-2', {
      id: 'm2',
      sessionId: 'project-session-2',
      timestamp: '2026-01-01T00:00:00.000Z',
      provider: 'codex',
      kind: 'text',
      role: 'assistant',
      content: 'two',
    });

    sessionsDb.deleteSessionsByProjectPath('/workspace/to-delete');

    assert.equal(sessionMessagesDb.list('project-session-1').total, 0);
    assert.equal(sessionMessagesDb.list('project-session-2').total, 0);
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
    assert.deepEqual(project.sessionsByProvider.claude!.map((s) => s.id), ['claude-1']);
    assert.equal(JSON.stringify(projects).includes('gemini-2'), false);
  });
});

test('synced auto names update but manual renames are never overwritten', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('s1', 'claude', '/workspace/demo-project', 'first prompt');
    sessionsDb.createSession('s1', 'claude', '/workspace/demo-project', 'AI title');
    assert.equal(sessionsDb.getSessionById('s1')?.custom_name, 'AI title');
    assert.equal(sessionsDb.getSessionById('s1')?.name_is_custom, 0);

    sessionsDb.updateSessionCustomName('s1', 'My name');
    sessionsDb.createSession('s1', 'claude', '/workspace/demo-project', 'newer AI title');
    sessionsDb.updateSessionCustomName('s1', 'auto again', false);
    assert.equal(sessionsDb.getSessionById('s1')?.custom_name, 'My name');
    assert.equal(sessionsDb.getSessionById('s1')?.name_is_custom, 1);
  });
});

test('legacy names (name_is_custom NULL) are kept only when not derivable from the transcript', () => {
  const legacy = (name: string) => ({ custom_name: name, name_is_custom: null });
  assert.equal(shouldKeepExistingSessionName(legacy('first prompt'), ['first prompt', 'AI title'], 'Untitled'), false);
  assert.equal(shouldKeepExistingSessionName(legacy('Renamed by user'), ['first prompt'], 'Untitled'), true);
  assert.equal(shouldKeepExistingSessionName(legacy('Untitled'), [], 'Untitled'), false);
  assert.equal(shouldKeepExistingSessionName({ custom_name: 'x', name_is_custom: 0 }, [], 'Untitled'), false);
});

test('legacy auto names truncated by the old code paths are not mistaken for manual renames', () => {
  const legacy = (name: string) => ({ custom_name: name, name_is_custom: null });
  const prompt = 'Run the shell command `ls -la` and tell me the output in one short sentence please';
  // antigravity-cli.js 的 slice(0, 50)
  assert.equal(shouldKeepExistingSessionName(legacy(prompt.slice(0, 50)), [prompt], 'Untitled'), false);
  // 前端 sessionSummary 的「80 字 + ...」與全形省略號
  assert.equal(shouldKeepExistingSessionName(legacy(`${prompt.slice(0, 80)}...`), [prompt], 'Untitled'), false);
  assert.equal(shouldKeepExistingSessionName(legacy(`${prompt.slice(0, 80)}…`), [prompt], 'Untitled'), false);
  // 不是任何推導名稱開頭的才當成手動命名
  assert.equal(shouldKeepExistingSessionName(legacy('My renamed chat...'), [prompt], 'Untitled'), true);
  assert.equal(shouldKeepExistingSessionName(legacy('...'), [prompt], 'Untitled'), true);
});

test('re-syncing an unchanged transcript keeps archived sessions archived; new activity restores them', async () => {
  await withIsolatedDatabase(() => {
    const project = '/workspace/demo-project';
    const mtime = '2026-11-01T00:00:00.000Z';
    sessionsDb.createSession('s-arch', 'antigravity', project, 'Name', mtime, mtime, '/tmp/t.jsonl');
    sessionsDb.updateSessionIsArchived('s-arch', true);

    // 完整重掃：transcript 修改時間沒變
    sessionsDb.createSession('s-arch', 'antigravity', project, 'Name', mtime, mtime, '/tmp/t.jsonl');
    assert.equal(sessionsDb.getSessionById('s-arch')?.isArchived, 1);

    // transcript 有新內容（修改時間前進）
    sessionsDb.createSession('s-arch', 'antigravity', project, 'Name', mtime, '2026-11-02T00:00:00.000Z', '/tmp/t.jsonl');
    assert.equal(sessionsDb.getSessionById('s-arch')?.isArchived, 0);

    // 進行中的對話（不帶時間）一律取消封存
    sessionsDb.updateSessionIsArchived('s-arch', true);
    sessionsDb.createSession('s-arch', 'antigravity', project, 'Name');
    assert.equal(sessionsDb.getSessionById('s-arch')?.isArchived, 0);
  });
});
