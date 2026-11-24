/**
 * 多 Agent REST API（multi-agent-workspace design D2–D7）。掛在 `/api/multi-agent`，走 JWT 驗證。
 */
import crypto from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express, { type Request, type Response } from 'express';

import { multiAgentsDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { isMultiAgentWorkspace, MULTI_AGENT_WORKSPACE_ROOT } from '@/shared/multi-agent-workspace.js';
import { AppError, asyncHandler, createApiSuccessResponse, validateWorkspacePath } from '@/shared/utils.js';

import {
  isApprovalNode,
  validateDefinition,
  validateModels,
  type ChatroomDef,
  type MultiAgent,
  type MultiAgentDefinition,
  type MultiAgentKind,
  type WorkflowDef,
} from '../../../shared/multiAgent.js';
import { isLLMProvider, type LLMProvider } from '../../../shared/providers.js';

import { chatroomDispatcher } from './services/chatroom-dispatcher.js';
import { workflowRunner } from './services/workflow-runner.js';

const router = express.Router();

const userIdOf = (req: Request): number => {
  const user = (req as Request & { user?: { id?: number; userId?: number } }).user;
  const id = user?.id ?? user?.userId;
  if (id === undefined) throw new AppError('Unauthorized', { statusCode: 401, code: 'UNAUTHORIZED' });
  return id;
};

const requireAgent = (req: Request): MultiAgent & { userId: number } => {
  const userId = userIdOf(req);
  const agent = multiAgentsDb.get(userId, String(req.params.id));
  if (!agent) throw new AppError('Multi-agent not found', { statusCode: 404, code: 'NOT_FOUND' });
  return { ...agent, userId };
};

const badRequest = (message: string, details?: unknown) =>
  new AppError(message, { statusCode: 400, code: 'VALIDATION_ERROR', details });

const providersOf = (kind: MultiAgentKind, def: MultiAgentDefinition): LLMProvider[] => [...new Set(
  kind === 'workflow'
    ? (def as WorkflowDef).nodes.filter((n) => !isApprovalNode(n)).map((n) => n.provider as LLMProvider)
    : (def as ChatroomDef).members.map((m) => m.provider),
)];

/** 結構與模型校驗。模型清單來自 providerModelsService（live 或其 fallback）。 */
async function assertValid(kind: MultiAgentKind, def: unknown): Promise<MultiAgentDefinition> {
  const errors = validateDefinition(kind, def);
  if (errors.length) throw badRequest(errors[0], { errors });
  const valid = def as MultiAgentDefinition;
  const lists = await Promise.all(providersOf(kind, valid).map(async (provider) => {
    const list = await providerModelsService.listProviderModels(provider);
    return [provider, list.models.map((m) => m.value)] as const;
  }));
  const modelErrors = validateModels(kind, valid, Object.fromEntries(lists));
  if (modelErrors.length) throw badRequest(modelErrors[0], { errors: modelErrors, code: 'MODEL_INVALID' });
  return valid;
}

/** 校驗並解析工作目錄：必須是存在的目錄，且不是系統目錄 */
async function resolveWorkspace(input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) throw badRequest('workspacePath is required');
  const expanded = trimmed.startsWith('~') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
  const validation = await validateWorkspacePath(expanded);
  if (!validation.valid || !validation.resolvedPath) throw badRequest(validation.error ?? 'Invalid workspace path');
  const info = await stat(validation.resolvedPath).catch(() => null);
  if (!info?.isDirectory()) throw badRequest('Workspace path must be an existing directory');
  return validation.resolvedPath;
}

const isBusy = (agent: MultiAgent) =>
  agent.kind === 'workflow' ? workflowRunner.isActive(agent.id) : false;

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(multiAgentsDb.list(userIdOf(req))));
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = userIdOf(req);
  const kind = req.body?.kind;
  if (kind !== 'chatroom' && kind !== 'workflow') throw badRequest('kind must be chatroom or workflow');
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 100) : null;
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : null;

  // 優先使用明確指定的目錄，其次綁定目前選中的專案路徑（同樣校驗目錄有效），否則用專屬目錄
  let projectPath: string | null = null;
  if (typeof req.body?.workspacePath === 'string' && req.body.workspacePath.trim()) {
    projectPath = await resolveWorkspace(req.body.workspacePath);
  } else if (projectId) {
    const rawProjectPath = projectsDb.getProjectPathById(projectId);
    if (!rawProjectPath) throw badRequest('Project not found');
    projectPath = await resolveWorkspace(rawProjectPath);
  }
  const id = crypto.randomUUID();
  const workspacePath = projectPath ?? path.join(MULTI_AGENT_WORKSPACE_ROOT, id);
  if (!projectPath) await mkdir(workspacePath, { recursive: true });

  const agent = multiAgentsDb.create(userId, {
    id,
    kind,
    name: name ?? (kind === 'workflow' ? '新工作流' : '新聊天室'),
    workspacePath,
  });
  res.status(201).json(createApiSuccessResponse(agent));
}));

/** 建立器沿用聊天頁，需要工作目錄對應的專案列（專屬目錄不會出現在側邊欄） */
const projectIdFor = (workspacePath: string): string | null => {
  const existing = projectsDb.getProjectPath(workspacePath);
  if (existing) return existing.project_id;
  return projectsDb.createProjectPath(workspacePath).project?.project_id ?? null;
};

router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  res.json(createApiSuccessResponse({ ...agent, projectId: projectIdFor(agent.workspacePath) }));
}));

router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
  if (name) multiAgentsDb.rename(agent.userId, agent.id, name);
  if (typeof req.body?.workspacePath === 'string') {
    if (workflowRunner.isActive(agent.id) || chatroomDispatcher.isBusy(agent.id)) {
      throw new AppError('Cannot change workspace while running', { statusCode: 409, code: 'BUSY' });
    }
    const workspacePath = await resolveWorkspace(req.body.workspacePath);
    multiAgentsDb.setWorkspacePath(agent.userId, agent.id, workspacePath);
  }
  const builderSession = req.body?.builderSession;
  if (builderSession !== undefined && builderSession !== null) {
    const sid = typeof builderSession.sessionId === 'string' ? builderSession.sessionId.trim() : '';
    const prov = builderSession.provider;
    if (!sid || sid.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(sid) || !isLLMProvider(prov)) {
      throw badRequest('Invalid builderSession');
    }
    const existingOwner = multiAgentsDb.getMultiAgentSessionOwner(sid);
    if (existingOwner && String(existingOwner.userId) !== String(agent.userId)) {
      throw new AppError('Session belongs to another user', { statusCode: 403, code: 'FORBIDDEN' });
    }
    multiAgentsDb.setBuilderSession(agent.userId, agent.id, {
      provider: prov,
      sessionId: sid,
      ...(Number.isInteger(builderSession.promptVersion) ? { promptVersion: builderSession.promptVersion } : {}),
    });
  }
  res.json(createApiSuccessResponse(multiAgentsDb.get(agent.userId, agent.id)));
}));

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  chatroomDispatcher.markDeleting(agent.id);
  try {
    await workflowRunner.stopByAgent(agent.id);
    await chatroomDispatcher.stopAndWait(agent.id);
    multiAgentsDb.delete(agent.userId, agent.id);
    if (isMultiAgentWorkspace(agent.workspacePath)) {
      sessionsDb.deleteSessionsByProjectPath(agent.workspacePath);
      projectsDb.deleteProjectPath(agent.workspacePath);
      await rm(agent.workspacePath, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    chatroomDispatcher.clearDeleting(agent.id);
  }
  res.json(createApiSuccessResponse({ id: agent.id }));
}));

router.put('/:id/definition', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  if (isBusy(agent)) throw new AppError('Workflow is running', { statusCode: 409, code: 'BUSY' });
  const definition = await assertValid(agent.kind, req.body?.definition);
  if (agent.kind === 'chatroom') {
    chatroomDispatcher.pruneMemberSessions(agent.id, definition as ChatroomDef);
  }
  res.json(createApiSuccessResponse(multiAgentsDb.setDefinition(agent.userId, agent.id, definition)));
}));

// ----------------- 工作流執行 -----------------

router.post('/:id/runs', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  if (agent.kind !== 'workflow' || !agent.definition) throw badRequest('Not a workflow with a definition');
  // 啟動前再次以模型服務驗證
  await assertValid('workflow', agent.definition);
  const input = typeof req.body?.input === 'string' ? req.body.input.slice(0, 20_000) : '';
  const started = workflowRunner.start(agent, input);
  if (!started) throw new AppError('Too many concurrent workflow runs (max 5)', { statusCode: 409, code: 'BUSY' });
  res.status(201).json(createApiSuccessResponse(started.run));
}));

router.get('/:id/runs', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  res.json(createApiSuccessResponse(multiAgentsDb.listRuns(agent.id)));
}));

router.get('/:id/runs/latest', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  res.json(createApiSuccessResponse(multiAgentsDb.listRuns(agent.id, 1)[0] ?? null));
}));

router.get('/:id/runs/:runId', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  const run = multiAgentsDb.getRun(agent.id, String(req.params.runId));
  if (!run) throw new AppError('Run not found', { statusCode: 404, code: 'NOT_FOUND' });
  res.json(createApiSuccessResponse(run));
}));

/** 人工確認節點：{ approved, rework?, note } */
router.post('/:id/runs/:runId/nodes/:nodeId/confirm', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  const run = multiAgentsDb.getRun(agent.id, String(req.params.runId));
  if (!run) throw new AppError('Run not found', { statusCode: 404, code: 'NOT_FOUND' });
  const rework = req.body?.rework === true;
  if (!rework && typeof req.body?.approved !== 'boolean') throw badRequest('approved must be boolean');
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 20_000) : '';
  const decision = rework ? 'rework' : req.body.approved ? 'approve' : 'reject';
  const ok = workflowRunner.confirm(run.id, String(req.params.nodeId), decision, note);
  if (!ok) throw new AppError('Node is not waiting for confirmation', { statusCode: 409, code: 'NOT_WAITING' });
  res.json(createApiSuccessResponse({ ok }));
}));

/** 同步該節點會話中最新 AI 回覆並繼續往後流轉下游（含人工確認節點） */
router.post('/:id/runs/:runId/nodes/:nodeId/continue', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  const run = multiAgentsDb.getRun(agent.id, String(req.params.runId));
  if (!run) throw new AppError('Run not found', { statusCode: 404, code: 'NOT_FOUND' });
  const ok = workflowRunner.continueDownstream(agent.id, run.id, String(req.params.nodeId));
  if (!ok) throw new AppError('Cannot continue workflow from this node', { statusCode: 409, code: 'CANNOT_CONTINUE' });
  res.json(createApiSuccessResponse({ ok }));
}));

/** 使用者中斷後等待指示的節點：{ outcome: 'complete' | 'fail' } */
router.post('/:id/runs/:runId/nodes/:nodeId/finish', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  const run = multiAgentsDb.getRun(agent.id, String(req.params.runId));
  if (!run) throw new AppError('Run not found', { statusCode: 404, code: 'NOT_FOUND' });
  const outcome = req.body?.outcome;
  if (outcome !== 'complete' && outcome !== 'fail') throw badRequest("outcome must be 'complete' or 'fail'");
  const ok = workflowRunner.finishWaitingInput(run.id, String(req.params.nodeId), outcome);
  if (!ok) throw new AppError('Node is not waiting for input', { statusCode: 409, code: 'NOT_WAITING' });
  res.json(createApiSuccessResponse({ ok }));
}));

router.post('/:id/runs/:runId/stop', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  const run = multiAgentsDb.getRun(agent.id, String(req.params.runId));
  if (!run) throw new AppError('Run not found', { statusCode: 404, code: 'NOT_FOUND' });
  const stopped = await workflowRunner.stop(run.id);
  res.json(createApiSuccessResponse({ stopped }));
}));

// ----------------- 聊天室 -----------------

router.get('/:id/messages', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  const beforeSeq = Number(req.query.beforeSeq);
  const limit = Number(req.query.limit);
  const messages = multiAgentsDb.listMessages(agent.id, {
    beforeSeq: Number.isFinite(beforeSeq) ? beforeSeq : undefined,
    limit: Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50,
  });
  const activeTurn = multiAgentsDb.getActiveTurn(agent.id);
  res.json(createApiSuccessResponse({ messages, activeTurnId: activeTurn?.id ?? null }));
}));

router.post('/:id/messages', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  if (agent.kind !== 'chatroom' || !agent.definition) throw badRequest('Not a chatroom with a definition');
  if (chatroomDispatcher.isDeleting(agent.id)) {
    throw new AppError('Chatroom is being deleted', { statusCode: 409, code: 'DELETING' });
  }
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content) throw badRequest('content is required');
  if (content.length > 20_000) throw badRequest('content is too long');
  res.status(201).json(createApiSuccessResponse(chatroomDispatcher.send(agent, content)));
}));

router.delete('/:id/messages/:messageId', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  const ok = multiAgentsDb.deleteQueuedMessage(agent.id, String(req.params.messageId));
  if (!ok) throw new AppError('Only queued messages can be cancelled', { statusCode: 409, code: 'NOT_QUEUED' });
  res.json(createApiSuccessResponse({ id: req.params.messageId }));
}));

router.post('/:id/messages/stop', asyncHandler(async (req: Request, res: Response) => {
  const agent = requireAgent(req);
  const turnId = typeof req.body?.turnId === 'string' ? req.body.turnId : '';
  if (!turnId) throw badRequest('turnId is required');
  res.json(createApiSuccessResponse({ stopped: await chatroomDispatcher.stop(agent.id, turnId) }));
}));

export default router;
