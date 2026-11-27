import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, multiAgentsDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import multiAgentRouter from '@/modules/multi-agent/multi-agent.routes.js';
import { getArchivedProjectsWithSessions } from '@/modules/projects/index.js';
import { providerRouter } from '@/modules/providers/index.js';
import { MULTI_AGENT_WORKSPACE_ROOT } from '@/shared/multi-agent-workspace.js';
import { AppError } from '@/shared/utils.js';

async function withTestApp(run: (baseUrl: string, tmpDir: string) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'ma-routes-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tmpDir, 'auth.db');
  await initializeDatabase();

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const uid = Number(req.headers['x-test-user'] ?? '1');
    (req as Request & { user?: { id: number } }).user = { id: uid };
    next();
  });
  app.use('/api/multi-agent', multiAgentRouter);
  app.use('/api/providers', providerRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    await run(baseUrl, tmpDir);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test('PATCH /api/multi-agent/:id 拒絕非法 builderSession.provider 與跨使用者綁定他人會話', async () => {
  await withTestApp(async (baseUrl, tmpDir) => {
    const agent1 = multiAgentsDb.create(1, { kind: 'workflow', name: 'u1', workspacePath: tmpDir });
    const agent2 = multiAgentsDb.create(2, { kind: 'workflow', name: 'u2', workspacePath: tmpDir });
    multiAgentsDb.setBuilderSession(1, agent1.id, { provider: 'claude', sessionId: 'u1-builder' });

    // 非法 provider
    const r1 = await fetch(`${baseUrl}/api/multi-agent/${agent1.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': '1' },
      body: JSON.stringify({ builderSession: { provider: 'evil-provider', sessionId: 's-any' } }),
    });
    assert.equal(r1.status, 400);

    // 使用者 2 嘗試把使用者 1 的會話綁為自己的 builderSession
    const r2 = await fetch(`${baseUrl}/api/multi-agent/${agent2.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': '2' },
      body: JSON.stringify({ builderSession: { provider: 'claude', sessionId: 'u1-builder' } }),
    });
    assert.equal(r2.status, 403);
  });
});

test('POST /api/multi-agent 傳入已失效的 projectId 目錄時應拒絕；DELETE 應清理專屬工作目錄與專案紀錄', async () => {
  await withTestApp(async (baseUrl, tmpDir) => {
    const goneDir = path.join(tmpDir, 'deleted-project');
    await mkdir(goneDir, { recursive: true });
    const createdProj = projectsDb.createProjectPath(goneDir).project!;
    await rm(goneDir, { recursive: true, force: true });

    const badCreate = await fetch(`${baseUrl}/api/multi-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'workflow', projectId: createdProj.project_id }),
    });
    assert.equal(badCreate.status, 400);

    // 不帶 projectId 建立專屬工作目錄的多 Agent
    const goodRes = await fetch(`${baseUrl}/api/multi-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'workflow', name: 'temp-wf' }),
    });
    assert.equal(goodRes.status, 201);
    const { data: createdAgent } = await goodRes.json() as { data: { id: string; workspacePath: string } };
    assert.equal(createdAgent.workspacePath, path.join(MULTI_AGENT_WORKSPACE_ROOT, createdAgent.id));
    assert.equal(existsSync(createdAgent.workspacePath), true);

    // GET /:id 會觸發 projectIdFor 建立 projects 列
    await fetch(`${baseUrl}/api/multi-agent/${createdAgent.id}`);
    assert.ok(projectsDb.getProjectPath(createdAgent.workspacePath));

    const delRes = await fetch(`${baseUrl}/api/multi-agent/${createdAgent.id}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    assert.equal(existsSync(createdAgent.workspacePath), false, '專屬工作目錄應隨多 Agent 刪除而清理');
    assert.equal(projectsDb.getProjectPath(createdAgent.workspacePath), null, '專屬目錄對應的 projects 列應一併刪除');
  });
});

test('GET /api/providers/sessions/:sessionId 支援尚未寫入 sessions 表的工作流節點會話，且拒絕非擁有者讀取', async () => {
  await withTestApp(async (baseUrl, tmpDir) => {
    const def = {
      nodes: [{ id: 'n1', title: '分析工單', instruction: 'go', provider: 'codex' as const, model: 'gpt-5', dependsOn: [] }],
    };
    const agent = multiAgentsDb.setDefinition(
      1,
      multiAgentsDb.create(1, { kind: 'workflow', name: 'wf', workspacePath: tmpDir }).id,
      def,
    )!;
    const run = multiAgentsDb.createRun(agent, { n1: { state: 'running', progress: 10, sessionId: 'live-only-session' } })!;
    multiAgentsDb.addWorkflowSession({
      sessionId: 'live-only-session',
      multiAgentId: agent.id,
      runId: run.id,
      nodeId: 'n1',
      userId: 1,
    });

    // 擁有者 user 1 可以直接打開尚未同步進 sessions 表的節點對話
    const okRes = await fetch(`${baseUrl}/api/providers/sessions/live-only-session`, {
      headers: { 'x-test-user': '1' },
    });
    assert.equal(okRes.status, 200);
    const { data } = await okRes.json() as {
      data: { provider: string; projectPath: string; workflow: { nodeTitle: string } | null };
    };
    assert.equal(data.provider, 'codex');
    assert.equal(data.projectPath, tmpDir);
    assert.equal(data.workflow?.nodeTitle, '分析工單');

    // 非擁有者 user 2 不可存取該工作流節點會話
    const forbiddenRes = await fetch(`${baseUrl}/api/providers/sessions/live-only-session`, {
      headers: { 'x-test-user': '2' },
    });
    assert.equal(forbiddenRes.status, 404);
  });
});

test('getArchivedProjectsWithSessions 排除多 Agent 專屬工作目錄與內部會話', async () => {
  await withTestApp(async (_baseUrl, tmpDir) => {
    const normalProj = path.join(tmpDir, 'normal');
    await mkdir(normalProj, { recursive: true });
    projectsDb.createProjectPath(normalProj);

    const maWorkspace = path.join(MULTI_AGENT_WORKSPACE_ROOT, 'archived-ma-test');
    projectsDb.createProjectPath(maWorkspace);
    projectsDb.updateProjectIsArchived(maWorkspace, true);

    const agent = multiAgentsDb.create(1, { kind: 'workflow', name: 'wf', workspacePath: normalProj });
    multiAgentsDb.setBuilderSession(1, agent.id, { provider: 'claude', sessionId: 'hidden-builder' });
    multiAgentsDb.addWorkflowSession({
      sessionId: 'hidden-wf-node',
      multiAgentId: agent.id,
      runId: 'r1',
      nodeId: 'a',
      userId: 1,
    });

    sessionsDb.createSession('visible-chat', 'claude', normalProj, 'Visible');
    sessionsDb.createSession('hidden-builder', 'claude', normalProj, 'Hidden Builder');
    sessionsDb.createSession('hidden-wf-node', 'claude', normalProj, 'Hidden Node');
    projectsDb.updateProjectIsArchived(normalProj, true);

    const archived = await getArchivedProjectsWithSessions({ skipSynchronization: true });
    assert.deepEqual(archived.map((p) => p.path), [normalProj], '不應包含多 Agent 專屬工作目錄');
    const claudeIds = (archived[0].sessionsByProvider.claude ?? []).map((s) => s.id);
    assert.deepEqual(claudeIds, ['visible-chat'], '封存專案視圖不應暴露建立器與工作流節點會話');
  });
});

test('工作流執行記錄與聊天室對話記錄支援「先歸檔、可還原、及永久刪除」', async () => {
  await withTestApp(async (baseUrl, tmpDir) => {
    const wf = multiAgentsDb.setDefinition(
      1,
      multiAgentsDb.create(1, { kind: 'workflow', name: 'wf', workspacePath: tmpDir }).id,
      { nodes: [{ id: 'n1', title: 'N1', instruction: 'go', provider: 'claude' as const, model: 'sonnet', dependsOn: [] }] },
    )!;
    const run = multiAgentsDb.createRun(wf, { n1: { state: 'succeeded', progress: 100 } })!;
    multiAgentsDb.addWorkflowSession({ sessionId: 'run-sid', multiAgentId: wf.id, runId: run.id, nodeId: 'n1', userId: 1 });

    // 1. 預設 DELETE 先歸檔
    const archRunRes = await fetch(`${baseUrl}/api/multi-agent/${wf.id}/runs/${run.id}`, { method: 'DELETE' });
    assert.equal(archRunRes.status, 200);
    assert.equal(multiAgentsDb.getRun(wf.id, run.id)?.isArchived, true, '應先標記為已歸檔');
    assert.ok(multiAgentsDb.getWorkflowSession('run-sid'), '歸檔時保留節點會話紀錄以便還原');

    // 2. POST /restore 還原
    const restoreRunRes = await fetch(`${baseUrl}/api/multi-agent/${wf.id}/runs/${run.id}/restore`, { method: 'POST' });
    assert.equal(restoreRunRes.status, 200);
    assert.equal(multiAgentsDb.getRun(wf.id, run.id)?.isArchived, false, '還原後應恢復為活躍');

    // 3. DELETE ?force=true 永久刪除
    const delRunRes = await fetch(`${baseUrl}/api/multi-agent/${wf.id}/runs/${run.id}?force=true`, { method: 'DELETE' });
    assert.equal(delRunRes.status, 200);
    assert.equal(multiAgentsDb.getRun(wf.id, run.id), null);
    assert.equal(multiAgentsDb.getWorkflowSession('run-sid'), null);

    // 聊天室對話同樣支援先歸檔、可還原、永久刪除
    const chat = multiAgentsDb.create(1, { kind: 'chatroom', name: 'cr', workspacePath: tmpDir });
    const thread = multiAgentsDb.createThread(chat.id, '技術評審');
    multiAgentsDb.appendMessage({
      multiAgentId: chat.id,
      threadId: thread.id,
      turnId: null,
      authorKind: 'user',
      memberId: null,
      author: null,
      content: 'hi',
      status: 'done',
      finishReason: null,
    });

    const archThreadRes = await fetch(`${baseUrl}/api/multi-agent/${chat.id}/threads/${thread.id}`, { method: 'DELETE' });
    assert.equal(archThreadRes.status, 200);
    assert.equal(multiAgentsDb.listThreads(chat.id).find((t) => t.id === thread.id)?.isArchived, true);
    assert.equal(multiAgentsDb.listMessages(chat.id, { threadId: thread.id }).length, 1, '歸檔時訊息保留');

    const restoreThreadRes = await fetch(`${baseUrl}/api/multi-agent/${chat.id}/threads/${thread.id}/restore`, { method: 'POST' });
    assert.equal(restoreThreadRes.status, 200);
    assert.equal(multiAgentsDb.listThreads(chat.id).find((t) => t.id === thread.id)?.isArchived, false);

    const delThreadRes = await fetch(`${baseUrl}/api/multi-agent/${chat.id}/threads/${thread.id}?force=true`, { method: 'DELETE' });
    assert.equal(delThreadRes.status, 200);
    assert.deepEqual(multiAgentsDb.listMessages(chat.id, { threadId: thread.id }), []);
  });
});

test('永久刪除綁定一般專案的 Run、Thread 或多 Agent 時，一併清除 sessions 表紀錄避免內部會話洩漏回專案側邊欄', async () => {
  await withTestApp(async (baseUrl, tmpDir) => {
    const projDir = path.join(tmpDir, 'real-project');
    await mkdir(projDir, { recursive: true });
    projectsDb.createProjectPath(projDir);
    sessionsDb.createSession('normal-user-chat', 'claude', projDir, 'Normal');

    // 1. 工作流節點會話
    const wf = multiAgentsDb.setDefinition(
      1,
      multiAgentsDb.create(1, { kind: 'workflow', name: 'wf', workspacePath: projDir }).id,
      { nodes: [{ id: 'n1', title: 'N1', instruction: 'go', provider: 'claude' as const, model: 'sonnet', dependsOn: [] }] },
    )!;
    const run = multiAgentsDb.createRun(wf, { n1: { state: 'succeeded', progress: 100, sessionId: 'wf-node-sid' } })!;
    multiAgentsDb.addWorkflowSession({ sessionId: 'wf-node-sid', multiAgentId: wf.id, runId: run.id, nodeId: 'n1', userId: 1 });
    sessionsDb.createSession('wf-node-sid', 'claude', projDir, 'WF Node');

    const delRun = await fetch(`${baseUrl}/api/multi-agent/${wf.id}/runs/${run.id}?force=true`, { method: 'DELETE' });
    assert.equal(delRun.status, 200);
    assert.equal(sessionsDb.getSessionById('wf-node-sid'), null, '永久刪除 Run 後應一併刪除內部節點在 sessions 表的列');
    assert.deepEqual(sessionsDb.getSessionsByProjectPath(projDir).map((s) => s.session_id), ['normal-user-chat']);

    // 2. 聊天室子對話成員會話與整個多 Agent 刪除
    const chat = multiAgentsDb.setDefinition(
      1,
      multiAgentsDb.create(1, { kind: 'chatroom', name: 'cr', workspacePath: projDir }).id,
      { members: [{ id: 'pm', name: 'PM', persona: 'p', provider: 'claude' as const, model: 'sonnet' }], rules: { text: '', allowAiMentions: false, maxAiRepliesPerTurn: 1, unmentionedBehavior: 'all' as const } },
    )!;
    multiAgentsDb.setBuilderSession(1, chat.id, { provider: 'claude', sessionId: 'cr-builder-sid' });
    sessionsDb.createSession('cr-builder-sid', 'claude', projDir, 'Builder');

    const subThread = multiAgentsDb.createThread(chat.id, '子對話');
    multiAgentsDb.upsertMemberSession(chat.id, 'pm', { provider: 'claude', model: 'sonnet', sessionId: 'sub-member-sid', lastDeliveredSeq: 1 }, subThread.id);
    sessionsDb.createSession('sub-member-sid', 'claude', projDir, 'Sub Member');

    const delThread = await fetch(`${baseUrl}/api/multi-agent/${chat.id}/threads/${subThread.id}?force=true`, { method: 'DELETE' });
    assert.equal(delThread.status, 200);
    assert.equal(sessionsDb.getSessionById('sub-member-sid'), null, '永久刪除 Thread 後應一併刪除成員在 sessions 表的列');

    const delAgent = await fetch(`${baseUrl}/api/multi-agent/${chat.id}`, { method: 'DELETE' });
    assert.equal(delAgent.status, 200);
    assert.equal(sessionsDb.getSessionById('cr-builder-sid'), null, '刪除綁定專案的多 Agent 後應刪除建立器會話');
    assert.deepEqual(sessionsDb.getSessionsByProjectPath(projDir).map((s) => s.session_id), ['normal-user-chat']);
  });
});

test('已歸檔的聊天室對話拒絕發送新訊息，且歸檔對話時自動清除殘留的排隊訊息', async () => {
  await withTestApp(async (baseUrl, tmpDir) => {
    const chat = multiAgentsDb.setDefinition(
      1,
      multiAgentsDb.create(1, { kind: 'chatroom', name: 'cr', workspacePath: tmpDir }).id,
      { members: [{ id: 'pm', name: 'PM', persona: 'p', provider: 'claude' as const, model: 'sonnet' }], rules: { text: '', allowAiMentions: false, maxAiRepliesPerTurn: 1, unmentionedBehavior: 'all' as const } },
    )!;
    const thread = multiAgentsDb.createThread(chat.id, '待歸檔對話');
    multiAgentsDb.appendMessage({
      multiAgentId: chat.id, threadId: thread.id, turnId: null, authorKind: 'user', memberId: null, author: null,
      content: 'done msg', status: 'done', finishReason: null,
    });
    multiAgentsDb.appendMessage({
      multiAgentId: chat.id, threadId: thread.id, turnId: null, authorKind: 'user', memberId: null, author: null,
      content: 'queued msg', status: 'queued', finishReason: null,
    });

    const archRes = await fetch(`${baseUrl}/api/multi-agent/${chat.id}/threads/${thread.id}`, { method: 'DELETE' });
    assert.equal(archRes.status, 200);
    assert.equal(multiAgentsDb.nextQueuedMessage(chat.id, thread.id), null, '歸檔後殘留的 queued 訊息應被清除');
    assert.equal(multiAgentsDb.listMessages(chat.id, { threadId: thread.id }).length, 1, '已完成訊息保留');

    const postArchived = await fetch(`${baseUrl}/api/multi-agent/${chat.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '不該送進已歸檔對話', threadId: thread.id }),
    });
    assert.equal(postArchived.status, 409, '禁止向已歸檔對話發送新訊息');
  });
});
