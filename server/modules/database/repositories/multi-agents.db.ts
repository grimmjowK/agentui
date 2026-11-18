/**
 * 多 Agent 持久化（multi-agent-workspace design D2）。
 * 所有讀寫都以 user_id 隔離；run / turn 保存定義快照。
 */
import crypto from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

import type {
  ChatMessage,
  ChatMessageStatus,
  MultiAgent,
  MultiAgentDefinition,
  MultiAgentKind,
  NodeRunStatus,
  RunStatus,
  WorkflowDef,
  WorkflowRun,
} from '../../../../shared/multiAgent.js';
import type { LLMProvider } from '../../../../shared/providers.js';

type UserId = string | number;

export type MemberSession = {
  provider: LLMProvider;
  model: string;
  sessionId: string;
  lastDeliveredSeq: number;
  /** session 最後一次看到的設定；下一輪與目前定義比對，差異以「設定已更新」提示 */
  seen?: { name: string; persona: string; rulesText: string; maxReplyChars: number; allowAiMentions: boolean };
  /** 上次回覆被截斷時的字數上限，下一輪提示一次 */
  truncatedAt?: number;
};

type AgentRow = {
  id: string;
  user_id: number;
  kind: MultiAgentKind;
  name: string;
  definition_json: string | null;
  definition_version: number;
  builder_session_json: string | null;
  member_sessions_json: string;
  workspace_path: string;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  multi_agent_id: string;
  status: RunStatus;
  definition_version: number;
  definition_snapshot_json: string;
  node_states_json: string;
  start_input: string | null;
  started_at: string;
  finished_at: string | null;
};

type MessageRow = {
  id: string;
  multi_agent_id: string;
  turn_id: string | null;
  seq: number;
  author_kind: ChatMessage['authorKind'];
  member_id: string | null;
  author_snapshot_json: string | null;
  content: string;
  status: ChatMessageStatus;
  finish_reason: string | null;
  created_at: string;
};

export type TurnRow = {
  id: string;
  multi_agent_id: string;
  trigger_message_id: string;
  status: string;
  definition_snapshot_json: string;
  started_at: string;
  finished_at: string | null;
};

const now = () => new Date().toISOString();
const parse = <T>(json: string | null, fallback: T): T => {
  if (!json) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
};

const toAgent = (row: AgentRow): MultiAgent => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  definition: parse<MultiAgentDefinition | null>(row.definition_json, null),
  definitionVersion: row.definition_version,
  builderSession: parse(row.builder_session_json, null),
  workspacePath: row.workspace_path,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toRun = (row: RunRow): WorkflowRun => ({
  id: row.id,
  multiAgentId: row.multi_agent_id,
  status: row.status,
  definitionVersion: row.definition_version,
  definition: parse<WorkflowDef>(row.definition_snapshot_json, { nodes: [] }),
  nodeStates: parse<Record<string, NodeRunStatus>>(row.node_states_json, {}),
  startInput: row.start_input ?? null,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

const toMessage = (row: MessageRow): ChatMessage => ({
  id: row.id,
  multiAgentId: row.multi_agent_id,
  turnId: row.turn_id,
  seq: row.seq,
  authorKind: row.author_kind,
  memberId: row.member_id,
  author: parse(row.author_snapshot_json, null),
  content: row.content,
  status: row.status,
  finishReason: row.finish_reason,
  createdAt: row.created_at,
});

export const multiAgentsDb = {
  list(userId: UserId): MultiAgent[] {
    const rows = getConnection()
      .prepare('SELECT * FROM multi_agents WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as AgentRow[];
    return rows.map(toAgent);
  },

  get(userId: UserId, id: string): MultiAgent | null {
    const row = getConnection()
      .prepare('SELECT * FROM multi_agents WHERE id = ? AND user_id = ?')
      .get(id, userId) as AgentRow | undefined;
    return row ? toAgent(row) : null;
  },

  /** 不檢查擁有者，僅供後端執行器內部使用 */
  getById(id: string): (MultiAgent & { userId: number }) | null {
    const row = getConnection().prepare('SELECT * FROM multi_agents WHERE id = ?').get(id) as AgentRow | undefined;
    return row ? { ...toAgent(row), userId: row.user_id } : null;
  },

  create(userId: UserId, input: { kind: MultiAgentKind; name: string; workspacePath: string; id?: string }): MultiAgent {
    const id = input.id ?? crypto.randomUUID();
    const ts = now();
    getConnection()
      .prepare(`INSERT INTO multi_agents (id, user_id, kind, name, workspace_path, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, input.kind, input.name, input.workspacePath, ts, ts);
    return this.get(userId, id)!;
  },

  setWorkspacePath(userId: UserId, id: string, workspacePath: string): boolean {
    return getConnection()
      .prepare('UPDATE multi_agents SET workspace_path = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(workspacePath, now(), id, userId).changes > 0;
  },

  rename(userId: UserId, id: string, name: string): boolean {
    return getConnection()
      .prepare('UPDATE multi_agents SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(name, now(), id, userId).changes > 0;
  },

  /** 保存定義並遞增版本 */
  setDefinition(userId: UserId, id: string, definition: MultiAgentDefinition): MultiAgent | null {
    const changed = getConnection()
      .prepare(`UPDATE multi_agents SET definition_json = ?, definition_version = definition_version + 1, updated_at = ?
                WHERE id = ? AND user_id = ?`)
      .run(JSON.stringify(definition), now(), id, userId).changes;
    return changed ? this.get(userId, id) : null;
  },

  setBuilderSession(userId: UserId, id: string, session: { provider: LLMProvider; sessionId: string; promptVersion?: number }): boolean {
    return getConnection()
      .prepare('UPDATE multi_agents SET builder_session_json = ? WHERE id = ? AND user_id = ?')
      .run(JSON.stringify(session), id, userId).changes > 0;
  },

  getMemberSessions(id: string): Record<string, MemberSession> {
    const row = getConnection().prepare('SELECT member_sessions_json FROM multi_agents WHERE id = ?')
      .get(id) as { member_sessions_json: string } | undefined;
    return parse(row?.member_sessions_json ?? null, {});
  },

  setMemberSessions(id: string, sessions: Record<string, MemberSession>): void {
    getConnection().prepare('UPDATE multi_agents SET member_sessions_json = ? WHERE id = ?')
      .run(JSON.stringify(sessions), id);
  },

  touch(id: string): void {
    getConnection().prepare('UPDATE multi_agents SET updated_at = ? WHERE id = ?').run(now(), id);
  },

  /** 刪除多 Agent 及其執行、回合與訊息 */
  delete(userId: UserId, id: string): boolean {
    const db = getConnection();
    return db.transaction(() => {
      const changed = db.prepare('DELETE FROM multi_agents WHERE id = ? AND user_id = ?').run(id, userId).changes;
      if (!changed) return false;
      db.prepare('DELETE FROM multi_agent_runs WHERE multi_agent_id = ?').run(id);
      db.prepare('DELETE FROM multi_agent_turns WHERE multi_agent_id = ?').run(id);
      db.prepare('DELETE FROM multi_agent_messages WHERE multi_agent_id = ?').run(id);
      return true;
    })();
  },

  // ----------------- 工作流執行 -----------------

  /** 建立 run 並保存定義快照；已有 running/stopping run 時回傳 null */
  createRun(agent: MultiAgent, nodeStates: Record<string, NodeRunStatus>, startInput: string | null = null): WorkflowRun | null {
    const db = getConnection();
    return db.transaction(() => {
      const active = db.prepare(
        "SELECT 1 FROM multi_agent_runs WHERE multi_agent_id = ? AND status IN ('running', 'stopping')",
      ).get(agent.id);
      if (active) return null;
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO multi_agent_runs
                  (id, multi_agent_id, status, definition_version, definition_snapshot_json, node_states_json, start_input, started_at)
                  VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`)
        .run(id, agent.id, agent.definitionVersion, JSON.stringify(agent.definition), JSON.stringify(nodeStates), startInput, now());
      return toRun(db.prepare('SELECT * FROM multi_agent_runs WHERE id = ?').get(id) as RunRow);
    })();
  },

  updateRun(runId: string, patch: { status?: RunStatus; nodeStates?: Record<string, NodeRunStatus>; finished?: boolean }): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.status) { sets.push('status = ?'); args.push(patch.status); }
    if (patch.nodeStates) { sets.push('node_states_json = ?'); args.push(JSON.stringify(patch.nodeStates)); }
    if (patch.finished) { sets.push('finished_at = ?'); args.push(now()); }
    if (!sets.length) return;
    getConnection().prepare(`UPDATE multi_agent_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args, runId);
  },

  listRuns(multiAgentId: string, limit = 20): WorkflowRun[] {
    const rows = getConnection()
      .prepare('SELECT * FROM multi_agent_runs WHERE multi_agent_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(multiAgentId, limit) as RunRow[];
    return rows.map(toRun);
  },

  getRun(multiAgentId: string, runId: string): WorkflowRun | null {
    const row = getConnection()
      .prepare('SELECT * FROM multi_agent_runs WHERE id = ? AND multi_agent_id = ?')
      .get(runId, multiAgentId) as RunRow | undefined;
    return row ? toRun(row) : null;
  },

  hasActiveRun(multiAgentId: string): boolean {
    return !!getConnection().prepare(
      "SELECT 1 FROM multi_agent_runs WHERE multi_agent_id = ? AND status IN ('running', 'stopping')",
    ).get(multiAgentId);
  },

  // ----------------- 聊天室 -----------------

  appendMessage(input: Omit<ChatMessage, 'id' | 'seq' | 'createdAt'> & { id?: string }): ChatMessage {
    const db = getConnection();
    return db.transaction(() => {
      const { next } = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM multi_agent_messages WHERE multi_agent_id = ?',
      ).get(input.multiAgentId) as { next: number };
      const id = input.id ?? crypto.randomUUID();
      db.prepare(`INSERT INTO multi_agent_messages
                  (id, multi_agent_id, turn_id, seq, author_kind, member_id, author_snapshot_json, content, status, finish_reason, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.multiAgentId, input.turnId, next, input.authorKind, input.memberId,
          input.author ? JSON.stringify(input.author) : null, input.content, input.status, input.finishReason, now());
      return toMessage(db.prepare('SELECT * FROM multi_agent_messages WHERE id = ?').get(id) as MessageRow);
    })();
  },

  updateMessage(id: string, patch: { content?: string; status?: ChatMessageStatus; finishReason?: string | null; turnId?: string }): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.content !== undefined) { sets.push('content = ?'); args.push(patch.content); }
    if (patch.status) { sets.push('status = ?'); args.push(patch.status); }
    if (patch.finishReason !== undefined) { sets.push('finish_reason = ?'); args.push(patch.finishReason); }
    if (patch.turnId !== undefined) { sets.push('turn_id = ?'); args.push(patch.turnId); }
    if (!sets.length) return;
    getConnection().prepare(`UPDATE multi_agent_messages SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  },

  getMessage(multiAgentId: string, id: string): ChatMessage | null {
    const row = getConnection()
      .prepare('SELECT * FROM multi_agent_messages WHERE id = ? AND multi_agent_id = ?')
      .get(id, multiAgentId) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  },

  /** 只能刪除排隊中的使用者訊息 */
  deleteQueuedMessage(multiAgentId: string, id: string): boolean {
    return getConnection().prepare(
      "DELETE FROM multi_agent_messages WHERE id = ? AND multi_agent_id = ? AND status = 'queued' AND author_kind = 'user'",
    ).run(id, multiAgentId).changes > 0;
  },

  /** 分頁：beforeSeq 之前（不含）最新的 limit 則，依 seq 升冪回傳 */
  listMessages(multiAgentId: string, options: { beforeSeq?: number; limit?: number } = {}): ChatMessage[] {
    const limit = options.limit ?? 50;
    const rows = getConnection().prepare(
      `SELECT * FROM multi_agent_messages WHERE multi_agent_id = ? AND seq < ?
       ORDER BY seq DESC LIMIT ?`,
    ).all(multiAgentId, options.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  },

  /** seq 之後的訊息（不含 queued 與執行中訊息），供成員續接時增量送出 */
  listMessagesAfter(multiAgentId: string, afterSeq: number): ChatMessage[] {
    const rows = getConnection().prepare(
      `SELECT * FROM multi_agent_messages WHERE multi_agent_id = ? AND seq > ? AND status IN ('done', 'error')
       ORDER BY seq ASC`,
    ).all(multiAgentId, afterSeq) as MessageRow[];
    return rows.map(toMessage);
  },

  /**
   * 排隊訊息開始處理：重新取號到最後並標記 done。
   * 否則成員游標可能已越過它的舊 seq，續接時看不到這則訊息。
   */
  promoteQueuedMessage(multiAgentId: string, id: string, turnId: string): ChatMessage | null {
    const db = getConnection();
    return db.transaction(() => {
      const { next } = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM multi_agent_messages WHERE multi_agent_id = ?',
      ).get(multiAgentId) as { next: number };
      const changed = db.prepare(
        "UPDATE multi_agent_messages SET seq = ?, status = 'done', turn_id = ? WHERE id = ? AND multi_agent_id = ? AND status = 'queued'",
      ).run(next, turnId, id, multiAgentId).changes;
      return changed ? this.getMessage(multiAgentId, id) : null;
    })();
  },

  nextQueuedMessage(multiAgentId: string): ChatMessage | null {
    const row = getConnection().prepare(
      "SELECT * FROM multi_agent_messages WHERE multi_agent_id = ? AND status = 'queued' ORDER BY seq ASC LIMIT 1",
    ).get(multiAgentId) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  },

  createTurn(multiAgentId: string, triggerMessageId: string, snapshot: MultiAgentDefinition): TurnRow {
    const id = crypto.randomUUID();
    const db = getConnection();
    db.prepare(`INSERT INTO multi_agent_turns (id, multi_agent_id, trigger_message_id, status, definition_snapshot_json, started_at)
                VALUES (?, ?, ?, 'running', ?, ?)`)
      .run(id, multiAgentId, triggerMessageId, JSON.stringify(snapshot), now());
    return db.prepare('SELECT * FROM multi_agent_turns WHERE id = ?').get(id) as TurnRow;
  },

  updateTurn(id: string, status: string, finished = false): void {
    getConnection().prepare(`UPDATE multi_agent_turns SET status = ?${finished ? ', finished_at = ?' : ''} WHERE id = ?`)
      .run(...(finished ? [status, now(), id] : [status, id]));
  },

  getActiveTurn(multiAgentId: string): TurnRow | null {
    return (getConnection().prepare(
      "SELECT * FROM multi_agent_turns WHERE multi_agent_id = ? AND status IN ('running', 'stopping') LIMIT 1",
    ).get(multiAgentId) as TurnRow | undefined) ?? null;
  },

  /** 服務啟動時把中斷的執行標記為 interrupted / failed */
  markInterrupted(): void {
    const db = getConnection();
    db.transaction(() => {
      const runs = db.prepare("SELECT * FROM multi_agent_runs WHERE status IN ('running', 'stopping')").all() as RunRow[];
      for (const run of runs) {
        const states = parse<Record<string, NodeRunStatus>>(run.node_states_json, {});
        for (const state of Object.values(states)) {
          if (state.state === 'running' || state.state === 'waiting_approval' || state.state === 'waiting_confirmation') {
            state.state = 'failed';
            state.error = 'interrupted';
          } else if (state.state === 'pending') {
            state.state = 'skipped';
          }
        }
        db.prepare("UPDATE multi_agent_runs SET status = 'interrupted', node_states_json = ?, finished_at = ? WHERE id = ?")
          .run(JSON.stringify(states), now(), run.id);
      }
      db.prepare("UPDATE multi_agent_turns SET status = 'interrupted', finished_at = ? WHERE status IN ('running', 'stopping')")
        .run(now());
      db.prepare("UPDATE multi_agent_messages SET status = 'error', finish_reason = 'interrupted' WHERE status = 'streaming'")
        .run();
    })();
  },
};
