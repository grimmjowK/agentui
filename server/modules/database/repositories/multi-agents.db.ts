/**
 * 多 Agent 持久化（multi-agent-workspace design D2）。
 * 所有讀寫都以 user_id 隔離；run / turn 保存定義快照。
 */
import crypto from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

import type {
  ChatMessage,
  ChatMessageStatus,
  ChatThread,
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
  is_archived?: number;
  started_at: string;
  finished_at: string | null;
};

type MessageRow = {
  id: string;
  multi_agent_id: string;
  thread_id?: string;
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

type ThreadRow = {
  id: string;
  multi_agent_id: string;
  title: string;
  member_sessions_json: string;
  is_archived?: number;
  created_at: string;
  updated_at: string;
};

export type TurnRow = {
  id: string;
  multi_agent_id: string;
  thread_id?: string;
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
  isArchived: Boolean(row.is_archived),
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

const toMessage = (row: MessageRow): ChatMessage => ({
  id: row.id,
  multiAgentId: row.multi_agent_id,
  threadId: row.thread_id ?? 'default',
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

const toThread = (row: ThreadRow): ChatThread => ({
  id: row.id,
  multiAgentId: row.multi_agent_id,
  title: row.title,
  isArchived: Boolean(row.is_archived),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
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
    const db = getConnection();
    return db.transaction(() => {
      const changed = db
        .prepare('UPDATE multi_agents SET builder_session_json = ? WHERE id = ? AND user_id = ?')
        .run(JSON.stringify(session), id, userId).changes > 0;
      if (changed) {
        db.prepare("DELETE FROM multi_agent_sessions WHERE multi_agent_id = ? AND role = 'builder'").run(id);
        db.prepare(`INSERT OR REPLACE INTO multi_agent_sessions (session_id, multi_agent_id, user_id, role, created_at)
          VALUES (?, ?, ?, 'builder', ?)`).run(session.sessionId, id, userId, now());
      }
      return changed;
    })();
  },

  getMemberSessions(id: string, threadId = 'default'): Record<string, MemberSession> {
    if (threadId !== 'default') {
      const tRow = getConnection()
        .prepare('SELECT member_sessions_json FROM multi_agent_threads WHERE multi_agent_id = ? AND id = ?')
        .get(id, threadId) as { member_sessions_json: string } | undefined;
      return parse(tRow?.member_sessions_json ?? null, {});
    }
    const row = getConnection().prepare('SELECT member_sessions_json FROM multi_agents WHERE id = ?')
      .get(id) as { member_sessions_json: string } | undefined;
    return parse(row?.member_sessions_json ?? null, {});
  },

  setMemberSessions(id: string, sessions: Record<string, MemberSession>, threadId = 'default'): void {
    const db = getConnection();
    db.transaction(() => {
      const row = db.prepare('SELECT user_id FROM multi_agents WHERE id = ?').get(id) as { user_id: number } | undefined;
      if (threadId === 'default') {
        db.prepare('UPDATE multi_agents SET member_sessions_json = ? WHERE id = ?')
          .run(JSON.stringify(sessions), id);
      } else {
        db.prepare('UPDATE multi_agent_threads SET member_sessions_json = ?, updated_at = ? WHERE multi_agent_id = ? AND id = ?')
          .run(JSON.stringify(sessions), now(), id, threadId);
      }
      if (row) {
        if (threadId === 'default') {
          db.prepare("DELETE FROM multi_agent_sessions WHERE multi_agent_id = ? AND role = 'member'").run(id);
        }
        const ts = now();
        const ins = db.prepare(`INSERT OR REPLACE INTO multi_agent_sessions (session_id, multi_agent_id, user_id, role, created_at)
          VALUES (?, ?, ?, 'member', ?)`);
        for (const s of Object.values(sessions)) {
          if (s.sessionId) ins.run(s.sessionId, id, row.user_id, ts);
        }
      }
    })();
  },

  /** 原子更新單一成員 session（僅當該成員仍存在於目前定義時寫入） */
  upsertMemberSession(id: string, memberId: string, session: MemberSession, threadId = 'default'): void {
    const db = getConnection();
    db.transaction(() => {
      const row = db.prepare('SELECT user_id, definition_json, member_sessions_json FROM multi_agents WHERE id = ?')
        .get(id) as { user_id: number; definition_json: string | null; member_sessions_json: string } | undefined;
      if (!row) return;
      const def = parse<{ members?: Array<{ id: string }> } | null>(row.definition_json, null);
      if (def?.members && !def.members.some((m) => m.id === memberId)) return;
      const tRow = threadId !== 'default'
        ? db.prepare('SELECT member_sessions_json FROM multi_agent_threads WHERE multi_agent_id = ? AND id = ?')
          .get(id, threadId) as { member_sessions_json: string } | undefined
        : undefined;
      const sessions = parse<Record<string, MemberSession>>(
        threadId === 'default' ? row.member_sessions_json : (tRow?.member_sessions_json ?? null),
        {},
      );
      const prev = sessions[memberId];
      if (prev?.sessionId && prev.sessionId !== session.sessionId) {
        db.prepare("DELETE FROM multi_agent_sessions WHERE session_id = ? AND multi_agent_id = ? AND role = 'member'")
          .run(prev.sessionId, id);
      }
      sessions[memberId] = session;
      if (threadId === 'default') {
        db.prepare('UPDATE multi_agents SET member_sessions_json = ? WHERE id = ?')
          .run(JSON.stringify(sessions), id);
      } else {
        db.prepare('UPDATE multi_agent_threads SET member_sessions_json = ?, updated_at = ? WHERE multi_agent_id = ? AND id = ?')
          .run(JSON.stringify(sessions), now(), id, threadId);
      }
      if (session.sessionId) {
        db.prepare(`INSERT OR REPLACE INTO multi_agent_sessions (session_id, multi_agent_id, user_id, role, created_at)
          VALUES (?, ?, ?, 'member', ?)`).run(session.sessionId, id, row.user_id, now());
      }
    })();
  },

  /** 原子清除已不在定義中的成員 session（涵蓋預設對話與所有子對話） */
  pruneMemberSessions(id: string, validMemberIds: Iterable<string>): void {
    const valid = new Set(validMemberIds);
    const db = getConnection();
    const pruneJson = (raw: string): { changed: boolean; next: Record<string, MemberSession> } => {
      const sessions = parse<Record<string, MemberSession>>(raw, {});
      let changed = false;
      for (const [key, val] of Object.entries(sessions)) {
        if (!valid.has(key)) {
          if (val?.sessionId) {
            db.prepare("DELETE FROM multi_agent_sessions WHERE session_id = ? AND multi_agent_id = ? AND role = 'member'")
              .run(val.sessionId, id);
          }
          delete sessions[key];
          changed = true;
        }
      }
      return { changed, next: sessions };
    };
    db.transaction(() => {
      const row = db.prepare('SELECT member_sessions_json FROM multi_agents WHERE id = ?')
        .get(id) as { member_sessions_json: string } | undefined;
      if (!row) return;
      const main = pruneJson(row.member_sessions_json);
      if (main.changed) {
        db.prepare('UPDATE multi_agents SET member_sessions_json = ? WHERE id = ?')
          .run(JSON.stringify(main.next), id);
      }
      const threads = db.prepare('SELECT id, member_sessions_json FROM multi_agent_threads WHERE multi_agent_id = ?')
        .all(id) as Array<{ id: string; member_sessions_json: string }>;
      for (const t of threads) {
        const res = pruneJson(t.member_sessions_json);
        if (res.changed) {
          db.prepare('UPDATE multi_agent_threads SET member_sessions_json = ? WHERE multi_agent_id = ? AND id = ?')
            .run(JSON.stringify(res.next), id, t.id);
        }
      }
    })();
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
      db.prepare('DELETE FROM multi_agent_threads WHERE multi_agent_id = ?').run(id);
      db.prepare('DELETE FROM multi_agent_turns WHERE multi_agent_id = ?').run(id);
      db.prepare('DELETE FROM multi_agent_messages WHERE multi_agent_id = ?').run(id);
      db.prepare('DELETE FROM workflow_sessions WHERE multi_agent_id = ?').run(id);
      db.prepare('DELETE FROM multi_agent_sessions WHERE multi_agent_id = ?').run(id);
      return true;
    })();
  },

  /** 節點取得 sessionId 時登記；同一會話續接時保留第一次的登記 */
  addWorkflowSession(entry: { sessionId: string; multiAgentId: string; runId: string; nodeId: string; userId: UserId }): void {
    const db = getConnection();
    const ts = now();
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO workflow_sessions (session_id, multi_agent_id, run_id, node_id, user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(entry.sessionId, entry.multiAgentId, entry.runId, entry.nodeId, entry.userId, ts);
      db.prepare(`INSERT OR IGNORE INTO multi_agent_sessions (session_id, multi_agent_id, user_id, role, created_at)
        VALUES (?, ?, ?, 'workflow', ?)`).run(entry.sessionId, entry.multiAgentId, entry.userId, ts);
    })();
  },

  getWorkflowSession(sessionId: string): { multiAgentId: string; runId: string; nodeId: string; userId: number } | null {
    const row = getConnection().prepare('SELECT multi_agent_id, run_id, node_id, user_id FROM workflow_sessions WHERE session_id = ?')
      .get(sessionId) as { multi_agent_id: string; run_id: string; node_id: string; user_id: number } | undefined;
    return row ? { multiAgentId: row.multi_agent_id, runId: row.run_id, nodeId: row.node_id, userId: row.user_id } : null;
  },

  /** 查詢會話是否屬於某個多 Agent（工作流節點／建立器／聊天室成員），供擁有者授權檢查 */
  getMultiAgentSessionOwner(sessionId: string): { multiAgentId: string; userId: number; role: 'workflow' | 'builder' | 'member' } | null {
    const row = getConnection().prepare('SELECT multi_agent_id, user_id, role FROM multi_agent_sessions WHERE session_id = ?')
      .get(sessionId) as { multi_agent_id: string; user_id: number; role: 'workflow' | 'builder' | 'member' } | undefined;
    return row ? { multiAgentId: row.multi_agent_id, userId: row.user_id, role: row.role } : null;
  },

  // ----------------- 工作流執行 -----------------

  /** 建立 run 並保存定義快照；單一工作流同時最多允許 5 個並行執行實例 */
  createRun(agent: MultiAgent, nodeStates: Record<string, NodeRunStatus>, startInput: string | null = null): WorkflowRun | null {
    const db = getConnection();
    return db.transaction(() => {
      const { count } = db.prepare(
        "SELECT COUNT(*) AS count FROM multi_agent_runs WHERE multi_agent_id = ? AND status IN ('running', 'stopping')",
      ).get(agent.id) as { count: number };
      if (count >= 5) return null;
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
    else if (patch.status === 'running') { sets.push('finished_at = NULL'); }
    if (!sets.length) return;
    getConnection().prepare(`UPDATE multi_agent_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args, runId);
  },

  listRuns(multiAgentId: string, limit = 20): WorkflowRun[] {
    const rows = getConnection()
      .prepare('SELECT * FROM multi_agent_runs WHERE multi_agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?')
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

  archiveRun(multiAgentId: string, runId: string, archived: boolean): boolean {
    return getConnection()
      .prepare('UPDATE multi_agent_runs SET is_archived = ? WHERE id = ? AND multi_agent_id = ?')
      .run(archived ? 1 : 0, runId, multiAgentId).changes > 0;
  },

  deleteRun(multiAgentId: string, runId: string): boolean {
    const db = getConnection();
    return db.transaction(() => {
      const changed = db.prepare('DELETE FROM multi_agent_runs WHERE id = ? AND multi_agent_id = ?').run(runId, multiAgentId).changes;
      if (!changed) return false;
      const sessions = db.prepare('SELECT session_id FROM workflow_sessions WHERE multi_agent_id = ? AND run_id = ?')
        .all(multiAgentId, runId) as Array<{ session_id: string }>;
      for (const s of sessions) {
        db.prepare('DELETE FROM multi_agent_sessions WHERE session_id = ? AND multi_agent_id = ?').run(s.session_id, multiAgentId);
      }
      db.prepare('DELETE FROM workflow_sessions WHERE multi_agent_id = ? AND run_id = ?').run(multiAgentId, runId);
      return true;
    })();
  },

  // ----------------- 聊天室 -----------------

  /** 列出聊天室下的所有對話中繼資料（預設不限筆數，供活躍與歸檔記錄切換；舊訊息補建 default） */
  listThreads(multiAgentId: string, limit = -1): ChatThread[] {
    const db = getConnection();
    return db.transaction(() => {
      const hasDefaultMsg = db.prepare(
        "SELECT content, created_at FROM multi_agent_messages WHERE multi_agent_id = ? AND thread_id = 'default' ORDER BY seq ASC LIMIT 1",
      ).get(multiAgentId) as { content: string; created_at: string } | undefined;
      if (hasDefaultMsg) {
        const lastMsg = db.prepare(
          "SELECT created_at FROM multi_agent_messages WHERE multi_agent_id = ? AND thread_id = 'default' ORDER BY seq DESC LIMIT 1",
        ).get(multiAgentId) as { created_at: string } | undefined;
        db.prepare(`INSERT OR IGNORE INTO multi_agent_threads (id, multi_agent_id, title, member_sessions_json, created_at, updated_at)
                    VALUES ('default', ?, ?, '{}', ?, ?)`).run(
          multiAgentId,
          hasDefaultMsg.content.trim().slice(0, 32) || '預設對話',
          hasDefaultMsg.created_at,
          lastMsg?.created_at ?? hasDefaultMsg.created_at,
        );
      }
      const rows = db.prepare(
        'SELECT * FROM multi_agent_threads WHERE multi_agent_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?',
      ).all(multiAgentId, limit) as ThreadRow[];
      if (rows.length === 0) {
        const ts = now();
        db.prepare(`INSERT OR IGNORE INTO multi_agent_threads (id, multi_agent_id, title, member_sessions_json, created_at, updated_at)
                    VALUES ('default', ?, '新對話', '{}', ?, ?)`).run(multiAgentId, ts, ts);
        return (db.prepare('SELECT * FROM multi_agent_threads WHERE multi_agent_id = ?').all(multiAgentId) as ThreadRow[]).map(toThread);
      }
      return rows.map(toThread);
    })();
  },

  createThread(multiAgentId: string, title = '新對話'): ChatThread {
    const db = getConnection();
    const id = crypto.randomUUID();
    const ts = now();
    db.prepare(`INSERT INTO multi_agent_threads (id, multi_agent_id, title, member_sessions_json, created_at, updated_at)
                VALUES (?, ?, ?, '{}', ?, ?)`).run(id, multiAgentId, title.trim().slice(0, 60) || '新對話', ts, ts);
    return toThread(
      db.prepare('SELECT * FROM multi_agent_threads WHERE multi_agent_id = ? AND id = ?').get(multiAgentId, id) as ThreadRow,
    );
  },

  archiveThread(multiAgentId: string, threadId: string, archived: boolean): boolean {
    return getConnection()
      .prepare('UPDATE multi_agent_threads SET is_archived = ? WHERE multi_agent_id = ? AND id = ?')
      .run(archived ? 1 : 0, multiAgentId, threadId).changes > 0;
  },

  deleteThread(multiAgentId: string, threadId: string): boolean {
    const db = getConnection();
    return db.transaction(() => {
      const sessions = this.getMemberSessions(multiAgentId, threadId);
      for (const s of Object.values(sessions)) {
        if (s?.sessionId) {
          db.prepare("DELETE FROM multi_agent_sessions WHERE session_id = ? AND multi_agent_id = ? AND role = 'member'")
            .run(s.sessionId, multiAgentId);
        }
      }
      if (threadId === 'default') {
        db.prepare("UPDATE multi_agents SET member_sessions_json = '{}' WHERE id = ?").run(multiAgentId);
      }
      const msgChanged = db.prepare('DELETE FROM multi_agent_messages WHERE multi_agent_id = ? AND thread_id = ?')
        .run(multiAgentId, threadId).changes;
      db.prepare('DELETE FROM multi_agent_turns WHERE multi_agent_id = ? AND thread_id = ?')
        .run(multiAgentId, threadId);
      const threadChanged = db.prepare('DELETE FROM multi_agent_threads WHERE multi_agent_id = ? AND id = ?')
        .run(multiAgentId, threadId).changes;
      return threadChanged > 0 || msgChanged > 0;
    })();
  },

  appendMessage(input: Omit<ChatMessage, 'id' | 'seq' | 'createdAt'> & { id?: string; threadId?: string }): ChatMessage {
    const db = getConnection();
    const threadId = input.threadId || 'default';
    return db.transaction(() => {
      const { next } = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM multi_agent_messages WHERE multi_agent_id = ?',
      ).get(input.multiAgentId) as { next: number };
      const id = input.id ?? crypto.randomUUID();
      const ts = now();
      db.prepare(`INSERT INTO multi_agent_messages
                  (id, multi_agent_id, thread_id, turn_id, seq, author_kind, member_id, author_snapshot_json, content, status, finish_reason, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.multiAgentId, threadId, input.turnId, next, input.authorKind, input.memberId,
          input.author ? JSON.stringify(input.author) : null, input.content, input.status, input.finishReason, ts);
      // 同步確保 multi_agent_threads 存在，且在首則使用者訊息時自動更新對話標題
      if (input.authorKind === 'user') {
        const snippet = input.content.trim().replace(/\s+/g, ' ').slice(0, 32) || '新對話';
        db.prepare(`INSERT OR IGNORE INTO multi_agent_threads (id, multi_agent_id, title, member_sessions_json, created_at, updated_at)
                    VALUES (?, ?, ?, '{}', ?, ?)`).run(threadId, input.multiAgentId, snippet, ts, ts);
        db.prepare(`UPDATE multi_agent_threads
                    SET title = CASE WHEN title IN ('新對話', '新对话', 'New chat') THEN ? ELSE title END,
                        updated_at = ?
                    WHERE multi_agent_id = ? AND id = ?`).run(snippet, ts, input.multiAgentId, threadId);
      } else {
        db.prepare('UPDATE multi_agent_threads SET updated_at = ? WHERE multi_agent_id = ? AND id = ?')
          .run(ts, input.multiAgentId, threadId);
      }
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
  listMessages(multiAgentId: string, options: { threadId?: string; beforeSeq?: number; limit?: number } = {}): ChatMessage[] {
    const limit = options.limit ?? 50;
    const threadId = options.threadId || 'default';
    const rows = getConnection().prepare(
      `SELECT * FROM multi_agent_messages WHERE multi_agent_id = ? AND thread_id = ? AND seq < ?
       ORDER BY seq DESC LIMIT ?`,
    ).all(multiAgentId, threadId, options.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  },

  /** seq 之後的訊息（不含 queued 與執行中訊息），供成員續接時增量送出 */
  listMessagesAfter(multiAgentId: string, afterSeq: number, threadId = 'default'): ChatMessage[] {
    const rows = getConnection().prepare(
      `SELECT * FROM multi_agent_messages WHERE multi_agent_id = ? AND thread_id = ? AND seq > ? AND status IN ('done', 'error')
       ORDER BY seq ASC`,
    ).all(multiAgentId, threadId, afterSeq) as MessageRow[];
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

  nextQueuedMessage(multiAgentId: string, threadId = 'default'): ChatMessage | null {
    const row = getConnection().prepare(
      "SELECT * FROM multi_agent_messages WHERE multi_agent_id = ? AND thread_id = ? AND status = 'queued' ORDER BY seq ASC LIMIT 1",
    ).get(multiAgentId, threadId) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  },

  createTurn(multiAgentId: string, triggerMessageId: string, snapshot: MultiAgentDefinition, threadId = 'default'): TurnRow {
    const id = crypto.randomUUID();
    const db = getConnection();
    db.prepare(`INSERT INTO multi_agent_turns (id, multi_agent_id, thread_id, trigger_message_id, status, definition_snapshot_json, started_at)
                VALUES (?, ?, ?, ?, 'running', ?, ?)`)
      .run(id, multiAgentId, threadId, triggerMessageId, JSON.stringify(snapshot), now());
    return db.prepare('SELECT * FROM multi_agent_turns WHERE id = ?').get(id) as TurnRow;
  },

  updateTurn(id: string, status: string, finished = false): void {
    getConnection().prepare(`UPDATE multi_agent_turns SET status = ?${finished ? ', finished_at = ?' : ''} WHERE id = ?`)
      .run(...(finished ? [status, now(), id] : [status, id]));
  },

  getActiveTurn(multiAgentId: string, threadId = 'default'): TurnRow | null {
    return (getConnection().prepare(
      "SELECT * FROM multi_agent_turns WHERE multi_agent_id = ? AND thread_id = ? AND status IN ('running', 'stopping') LIMIT 1",
    ).get(multiAgentId, threadId) as TurnRow | undefined) ?? null;
  },

  getActiveTurns(multiAgentId: string): TurnRow[] {
    return getConnection().prepare(
      "SELECT * FROM multi_agent_turns WHERE multi_agent_id = ? AND status IN ('running', 'stopping')",
    ).all(multiAgentId) as TurnRow[];
  },

  /** 服務啟動時把中斷的執行標記為 interrupted / failed */
  markInterrupted(): void {
    const db = getConnection();
    db.transaction(() => {
      const runs = db.prepare("SELECT * FROM multi_agent_runs WHERE status IN ('running', 'stopping')").all() as RunRow[];
      for (const run of runs) {
        const states = parse<Record<string, NodeRunStatus>>(run.node_states_json, {});
        for (const state of Object.values(states)) {
          if (state.state === 'running' || state.state === 'waiting_approval' || state.state === 'waiting_confirmation' || state.state === 'waiting_input') {
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
