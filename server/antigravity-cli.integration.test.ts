import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import Database from 'better-sqlite3';

import { acpFakeAgent } from './shared/antigravity-acp-fake.test-helper.js';

import {
  spawnAntigravity,
  abortAntigravitySession,
  getActiveAntigravitySessions,
  isAntigravitySessionActive,
  reconnectAntigravitySession,
  resyncAntigravitySessionMetadata,
} from './antigravity-cli.js';
import { closeConnection } from './modules/database/connection.js';
import { initializeDatabase } from './modules/database/init-db.js';
import { sessionsDb, projectsDb, scanStateDb } from './modules/database/index.js';
import { sessionSynchronizerService } from './modules/providers/services/session-synchronizer.service.js';
import { AntigravitySessionSynchronizer } from './modules/providers/list/antigravity/antigravity-session-synchronizer.provider.js';
import { AntigravitySessionsProvider } from './modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { getProjectsWithSessions, getProjectSessionsPage, getArchivedProjectsWithSessions } from './modules/projects/services/projects-with-sessions-fetch.service.js';

test('Antigravity native IDs survive runs, refresh, pagination and cancellation', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-continuity-'));
  const previous = {
    DATABASE_PATH: process.env.DATABASE_PATH,
    ANTIGRAVITY_HOME: process.env.ANTIGRAVITY_HOME,
    ANTIGRAVITY_CLI_PATH: process.env.ANTIGRAVITY_CLI_PATH,
    ANTIGRAVITY_NATIVE_TITLE_RESYNC_DELAY_MS: process.env.ANTIGRAVITY_NATIVE_TITLE_RESYNC_DELAY_MS,
    FAKE_AGY_SESSION: process.env.FAKE_AGY_SESSION,
  };
  const workspace = path.join(root, 'workspace');
  const executable = path.join(root, 'agy');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'app.db');
  process.env.ANTIGRAVITY_HOME = root;
  process.env.ANTIGRAVITY_CLI_PATH = executable;
  process.env.ANTIGRAVITY_NATIVE_TITLE_RESYNC_DELAY_MS = '60000';
  try {
    await mkdir(workspace);
    await writeFile(process.env.DATABASE_PATH!, '');
    await initializeDatabase();
    await writeFile(executable, `#!${process.execPath}\n${acpFakeAgent(`
  fs.writeFileSync(path.join(home, 'argv.json'), JSON.stringify(process.argv.slice(2)));
  if (text === 'fail') { process.stderr.write('CLI startup failure'); process.exit(1); }
  if (text === 'wait') {
    ctx.onCancel(() => out({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } }));
    return undefined;
  }
  if (text === 'reconnect') {
    setTimeout(() => ctx.text('during disconnect'), 30);
    setTimeout(() => { ctx.text('after reconnect'); out({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }); }, 150);
    return undefined;
  }
  ctx.transcript([
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>' + text + '</USER_REQUEST>' },
    { type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'answer:' + text },
  ]);
  ctx.text('answer:' + text);
  return {};
`)}`, { mode: 0o755 });

    const messages: any[] = [];
    const observed: boolean[] = [];
    const writer = {
      isWebSocketWriter: true,
      send: (message: any) => {
        messages.push(message);
        if (message.kind === 'session_created') {
          observed.push(isAntigravitySessionActive(message.sessionId));
          observed.push(sessionsDb.getSessionById(message.sessionId)?.project_path === workspace);
          if (message.sessionId === 'waiting-native') observed.push(abortAntigravitySession(message.sessionId));
        }
      },
    };
    process.env.FAKE_AGY_SESSION = 'native-session';
    await spawnAntigravity('first', { cwd: workspace }, writer);
    assert.deepEqual(observed, [true, true]);
    assert.deepEqual(getActiveAntigravitySessions(), []);
    assert.equal(messages.filter((message) => message.kind === 'text').length, 1);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.ok(sessionsDb.getSessionById('native-session')?.jsonl_path);

    await spawnAntigravity('second', { cwd: workspace, sessionId: 'native-session' }, writer);
    const resumed = (await readFile(path.join(root, 'acp-calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line)).filter((call) => call.method === 'session/resume');
    assert.equal(resumed.at(-1)?.params.sessionId, 'native-session');
    const provider = new AntigravitySessionsProvider();
    const newest = await provider.fetchHistory('native-session', { limit: 2 });
    const older = await provider.fetchHistory('native-session', { limit: 2, offset: 2 });
    assert.deepEqual(newest.messages.map((message) => message.content), ['second', 'answer:second']);
    assert.deepEqual(older.messages.map((message) => message.content), ['first', 'answer:first']);
    assert.equal(newest.total, 4);
    assert.equal(newest.hasMore, true);
    assert.equal(older.hasMore, false);

    // Reopen the app database to exercise persistence, rather than a memory cache.
    closeConnection();
    const projects = await getProjectsWithSessions({ skipSynchronization: true });
    const project = projects.find((entry) => entry.path === workspace)!;
    assert.deepEqual(project.sessionsByProvider.antigravity!.map((session) => session.id), ['native-session']);
    const page = await getProjectSessionsPage(project.projectId, { limit: 1 });
    assert.equal(page.sessionsByProvider.antigravity![0].id, 'native-session');
    assert.equal((await provider.fetchHistory('native-session')).total, 4);

    const defaultArgs = JSON.parse(await readFile(path.join(root, 'argv.json'), 'utf8')) as string[];
    assert.equal(defaultArgs.includes('--dangerously-skip-permissions'), false, JSON.stringify(defaultArgs));
    process.env.FAKE_AGY_SESSION = 'permission-allowed';
    await spawnAntigravity('allowed', { cwd: workspace, permissionMode: 'bypassPermissions' }, writer);
    const allowedArgs = JSON.parse(await readFile(path.join(root, 'argv.json'), 'utf8')) as string[];
    assert.equal(allowedArgs.includes('--dangerously-skip-permissions'), true, JSON.stringify(allowedArgs));
    process.env.FAKE_AGY_SESSION = 'permission-default';
    await spawnAntigravity('default', { cwd: workspace, permissionMode: 'default', skipPermissions: true }, writer);
    const backToDefaultArgs = JSON.parse(await readFile(path.join(root, 'argv.json'), 'utf8')) as string[];
    assert.equal(backToDefaultArgs.includes('--dangerously-skip-permissions'), false, JSON.stringify(backToDefaultArgs));

    // An offline CLI transcript gets its workspace and title from the native summary DB.
    const externalLog = path.join(root, 'brain', 'offline-native', 'transcript.jsonl');
    await mkdir(path.dirname(externalLog), { recursive: true });
    await writeFile(externalLog, JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>Offline</USER_REQUEST>' }) + '\n');
    const lateLog = path.join(root, 'brain', 'late-native', 'transcript.jsonl');
    await mkdir(path.dirname(lateLog), { recursive: true });
    await writeFile(lateLog, JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>Late prompt</USER_REQUEST>', workspacePath: workspace }) + '\n');
    const nativeDb = new Database(path.join(root, 'conversation_summaries.db'));
    nativeDb.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT)');
    nativeDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(
      'offline-native',
      'Native offline title',
      JSON.stringify([pathToFileURL(workspace).href]),
    );
    nativeDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(
      'late-native',
      '',
      JSON.stringify([pathToFileURL(workspace).href]),
    );
    nativeDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(
      'native-session',
      null,
      JSON.stringify([pathToFileURL(path.join(root, 'canonical-alias')).href]),
    );
    nativeDb.close();
    const synchronizer = new AntigravitySessionSynchronizer();
    assert.equal(await synchronizer.synchronizeFile(externalLog), 'offline-native');
    assert.equal(sessionsDb.getSessionById('offline-native')?.project_path, workspace);
    assert.equal(sessionsDb.getSessionById('offline-native')?.custom_name, 'Native offline title');
    assert.equal(await synchronizer.synchronizeFile(lateLog), 'late-native');
    assert.equal(sessionsDb.getSessionById('late-native')?.custom_name, 'Late prompt');
    const lateDb = new Database(path.join(root, 'conversation_summaries.db'));
    lateDb.prepare('UPDATE conversation_summaries SET title = ? WHERE conversation_id = ?')
      .run('Late native title', 'late-native');
    lateDb.close();
    assert.equal(await resyncAntigravitySessionMetadata('late-native', lateLog), true);
    assert.equal(sessionsDb.getSessionById('late-native')?.custom_name, 'Late native title');
    const oldLog = path.join(root, 'brain', 'old-native', 'transcript.jsonl');
    await mkdir(path.dirname(oldLog), { recursive: true });
    await writeFile(oldLog, JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>Old</USER_REQUEST>', workspacePath: workspace }) + '\n');
    // 其他 provider 的游標前進到未來，不得影響 antigravity 自己的游標
    scanStateDb.updateLastScannedAt(new Date(Date.now() + 60_000), 'claude');
    assert.equal(scanStateDb.getLastScannedAt('antigravity'), null);
    await sessionSynchronizerService.synchronizeSessions();
    assert.ok(sessionsDb.getSessionById('old-native'));
    assert.ok(scanStateDb.getLastScannedAt('antigravity'));

    const disconnectedMessages: any[] = [];
    const reconnectedMessages: any[] = [];
    const oldSocket = { messages: disconnectedMessages, readyState: 1 };
    const newSocket = { messages: reconnectedMessages, readyState: 1 };
    const reconnectWriter = {
      isWebSocketWriter: true,
      userId: 'same-user',
      ws: oldSocket,
      updateWebSocket(socket: typeof oldSocket) { this.ws = socket; },
      send(message: any) {
        this.ws.messages.push(message);
        if (message.kind === 'session_created') {
          assert.equal(reconnectAntigravitySession(message.sessionId, {
            ws: newSocket, userId: 'other-user',
          }), false);
          oldSocket.readyState = 3;
          setTimeout(() => {
            assert.equal(reconnectAntigravitySession(message.sessionId, {
              ws: newSocket, userId: 'same-user',
            }), true);
          }, 90);
        }
      },
    };
    process.env.FAKE_AGY_SESSION = 'reconnect-native';
    await spawnAntigravity('reconnect', { cwd: workspace }, reconnectWriter);
    // The runtime no longer buffers disconnected events itself; LoggingWriter
    // persists durable rows and replays them after reconnect.
    assert.ok(disconnectedMessages.some((message) => message.kind === 'stream_delta' && message.content === 'during disconnect'));
    assert.ok(reconnectedMessages.some((message) => message.kind === 'stream_delta' && message.content === 'after reconnect'));
    assert.ok(reconnectedMessages.some((message) => message.kind === 'complete'));
    const originalLog = sessionsDb.getSessionById('native-session')!.jsonl_path!;
    await synchronizer.synchronizeFile(originalLog);
    assert.equal(sessionsDb.getSessionById('native-session')?.project_path, workspace);

    messages.length = 0;
    process.env.FAKE_AGY_SESSION = 'waiting-native';
    await spawnAntigravity('wait', { cwd: workspace }, writer);
    assert.ok(observed.every(Boolean));
    assert.deepEqual(getActiveAntigravitySessions(), []);
    assert.equal(messages.filter((message) => message.kind === 'complete' && message.aborted).length, 1);
    assert.equal(messages.filter((message) => message.kind === 'error').length, 0);

    const beforeFailure = sessionsDb.getAllSessions().length;
    process.env.FAKE_AGY_SESSION = 'startup-failure';
    await assert.rejects(spawnAntigravity('fail', { cwd: workspace }, writer), /CLI startup failure/);
    assert.equal(sessionsDb.getAllSessions().length, beforeFailure);
    assert.deepEqual(getActiveAntigravitySessions(), []);

    projectsDb.updateProjectIsArchivedById(project.projectId, true);
    const archived = await getArchivedProjectsWithSessions({ skipSynchronization: true });
    assert.ok(archived.find((entry) => entry.projectId === project.projectId)?.sessionsByProvider.antigravity!.some((session) => session.id === 'native-session'));
  } finally {
    for (const id of getActiveAntigravitySessions()) abortAntigravitySession(id);
    closeConnection();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
