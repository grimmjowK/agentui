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
