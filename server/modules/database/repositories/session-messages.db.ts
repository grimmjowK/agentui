import type { Database, Statement } from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import type { NormalizedMessage } from '@/shared/types.js';

type CachedStatements = {
  writeRow: Statement;
  maxSeq: Statement;
  getRow: Statement;
  getRawPayload: Statement;
  findById: Statement;
  listBySession: Statement;
  deleteBySession: Statement;
  selectIdsBySession: Statement;
  negateSeqBySession: Statement;
  updateSeqById: Statement;
  listSizes: Statement;
  findToolUse: Statement;
};

let cachedDb: Database | null = null;
let cachedStmts: CachedStatements | null = null;

function stmts(): CachedStatements {
  const db = getConnection();
  if (cachedDb === db && cachedStmts) {
    return cachedStmts;
  }
  cachedDb = db;
  cachedStmts = {
    writeRow: db.prepare(
      `INSERT INTO session_messages
         (session_id, id, seq, provider_ids, payload, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, id) DO UPDATE SET
         provider_ids = excluded.provider_ids,
         payload = excluded.payload,
         source = excluded.source,
         updated_at = excluded.updated_at`,
    ),
    maxSeq: db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_messages WHERE session_id = ?',
    ),
    getRow: db.prepare(
      `SELECT session_id, id, seq, provider_ids, payload, source, created_at, updated_at
       FROM session_messages
       WHERE session_id = ? AND id = ?`,
    ),
    getRawPayload: db.prepare(
      'SELECT payload FROM session_messages WHERE session_id = ? AND id = ?',
    ),
    findById: db.prepare(
      `SELECT session_id, id, seq, provider_ids, payload, source, created_at, updated_at
       FROM session_messages
       WHERE id = ?
       LIMIT 2`,
    ),
    listBySession: db.prepare(
      `SELECT session_id, id, seq, provider_ids, payload, source, created_at, updated_at
       FROM session_messages
       WHERE session_id = ?
       ORDER BY seq ASC`,
    ),
    deleteBySession: db.prepare(
      'DELETE FROM session_messages WHERE session_id = ?',
    ),
    selectIdsBySession: db.prepare(
      'SELECT id FROM session_messages WHERE session_id = ? ORDER BY seq ASC, id ASC',
    ),
    negateSeqBySession: db.prepare(
      'UPDATE session_messages SET seq = -seq WHERE session_id = ?',
    ),
    updateSeqById: db.prepare(
      'UPDATE session_messages SET seq = ? WHERE session_id = ? AND id = ?',
    ),
    // 只在 SQLite 側定位 tool_use，避免每個 tool_result 都把整個會話 payload 解析一遍
    findToolUse: db.prepare(
      `SELECT session_id, id, seq, provider_ids, payload, source, created_at, updated_at
       FROM session_messages
       WHERE session_id = ?
         AND json_extract(payload, '$.toolId') = ?
         AND json_extract(payload, '$.kind') = 'tool_use'
       ORDER BY seq ASC
       LIMIT 1`,
    ),
    listSizes: db.prepare(
      `SELECT
         sm.session_id AS sessionId,
         SUM(length(sm.payload)) AS bytes,
         MAX(sm.updated_at) AS updatedAt,
         COALESCE(s.isStarred, 0) AS starred
       FROM session_messages sm
       LEFT JOIN sessions s ON s.session_id = sm.session_id
       GROUP BY sm.session_id
       ORDER BY updatedAt ASC`,
    ),
  };
  return cachedStmts;
}

export type SessionMessageSource = 'live' | 'import';

export type SessionMessageRow = {
  sessionId: string;
  id: string;
  seq: number;
  providerIds: string[];
  payload: NormalizedMessage;
  source: SessionMessageSource;
  createdAt: number;
  updatedAt: number;
};

export type SessionMessageListOptions = {
  beforeSeq?: number | null;
  afterSeq?: number | null;
  offset?: number;
  limit?: number | null;
};

export type SessionMessagePage = {
  messages: NormalizedMessage[];
  rows: SessionMessageRow[];
  total: number;
  hasMore: boolean;
  nextBeforeSeq: number | null;
};

type SessionMessageDatabaseRow = {
  session_id: string;
  id: string;
  seq: number;
  provider_ids: string;
  payload: string;
  source: SessionMessageSource;
  created_at: number;
  updated_at: number;
};

const now = (): number => Date.now();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseProviderIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parsePayload(raw: string, id: string, sessionId: string, seq: number): NormalizedMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.kind !== 'string') {
      return null;
    }
    delete parsed._logUserId;
    return {
      ...parsed,
      id,
      sessionId,
      seq,
    } as NormalizedMessage;
  } catch {
    return null;
  }
}

function rowToMessage(row: SessionMessageDatabaseRow): SessionMessageRow | null {
  const payload = parsePayload(row.payload, row.id, row.session_id, row.seq);
  if (!payload) return null;
  return {
    sessionId: row.session_id,
    id: row.id,
    seq: row.seq,
    providerIds: parseProviderIds(row.provider_ids),
    payload,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mergeDefined(
  previous: NormalizedMessage,
  next: NormalizedMessage,
  preservedSeq: number,
): NormalizedMessage {
  const merged: NormalizedMessage = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined && value !== null) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  merged.id = previous.id;
  merged.sessionId = previous.sessionId;
  merged.seq = preservedSeq;
  return merged;
}

function extractAuditUserId(rawPayload: string | undefined): string | number | null {
  if (!rawPayload) return null;
  try {
    const value = JSON.parse(rawPayload)._logUserId;
    return typeof value === 'string' || typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

function getExistingAuditUserId(sessionId: string, id: string): string | number | null {
  const row = stmts().getRawPayload.get(sessionId, id) as { payload: string } | undefined;
  return extractAuditUserId(row?.payload);
}

function writeRow(
  message: NormalizedMessage,
  providerIds: string[],
  source: SessionMessageSource,
  auditUserId?: string | number | null,
): void {
  const timestamp = now();
  const resolvedAuditUserId = auditUserId !== undefined
    ? auditUserId
    : getExistingAuditUserId(message.sessionId, message.id);
  const payload = resolvedAuditUserId === undefined || resolvedAuditUserId === null
    ? message
    : { ...message, _logUserId: resolvedAuditUserId };
  stmts().writeRow.run(
    message.sessionId,
    message.id,
    message.seq,
    JSON.stringify([...new Set(providerIds)]),
    JSON.stringify(payload),
    source,
    timestamp,
    timestamp,
  );
}

function nextAppendSeq(sessionId: string): number {
  const row = stmts().maxSeq.get(sessionId) as { max_seq: number };
  return Math.floor(Number(row.max_seq) || 0) + 1;
}

function getRow(sessionId: string, id: string): SessionMessageRow | null {
  const row = stmts().getRow.get(sessionId, id) as SessionMessageDatabaseRow | undefined;
  return row ? rowToMessage(row) : null;
}

export const sessionMessagesDb = {
  append(
    sessionId: string,
    message: NormalizedMessage,
    source: SessionMessageSource = 'live',
  ): NormalizedMessage {
    const db = getConnection();
    return db.transaction(() => {
      const existing = getRow(sessionId, message.id);
      const seq = existing?.seq ?? nextAppendSeq(sessionId);
      const stored = {
        ...message,
        id: message.id,
        sessionId,
        seq,
      };
      writeRow(stored, stored.providerIds ?? [], source);
      return stored;
    })();
  },

  upsertById(
    sessionId: string,
    message: NormalizedMessage,
    source: SessionMessageSource = 'live',
  ): { message: NormalizedMessage; inserted: boolean; row: SessionMessageRow } {
    const db = getConnection();
    return db.transaction(() => {
      const existing = getRow(sessionId, message.id);
      const inserted = !existing;
      const merged = existing
        ? mergeDefined(existing.payload, message, existing.seq)
        : { ...message, sessionId, seq: nextAppendSeq(sessionId) };
      const providerIds = [
        ...(existing?.providerIds ?? []),
        ...(message.providerIds ?? []),
      ];
      writeRow(merged, providerIds, existing?.source ?? source);
      return {
        message: merged,
        inserted,
        row: getRow(sessionId, message.id)!,
      };
    })();
  },

  insertUserIfAbsent(
    sessionId: string,
    message: NormalizedMessage,
    userId: string | number | null = null,
  ): { status: 'inserted' | 'existing' | 'conflict'; message: NormalizedMessage | null } {
    if (message.kind !== 'text' || message.role !== 'user' || !message.id.startsWith('user:')) {
      return { status: 'conflict', message: null };
    }

    const db = getConnection();
    return db.transaction(() => {
      const sameId = stmts().findById.all(message.id) as SessionMessageDatabaseRow[];

      const existing = sameId.map(rowToMessage).find((entry): entry is SessionMessageRow => Boolean(entry));
      if (existing) {
        const auditUserId = extractAuditUserId(
          sameId.find((row) => row.session_id === sessionId)?.payload,
        );
        const sameUser = userId === null
          || auditUserId === null
          || String(auditUserId) === String(userId);
        if (
          existing.sessionId !== sessionId
          || existing.payload.kind !== 'text'
          || existing.payload.role !== 'user'
          || !sameUser
        ) {
          return { status: 'conflict' as const, message: null };
        }
        return { status: 'existing' as const, message: existing.payload };
      }

      const stored = {
        ...message,
        sessionId,
        seq: nextAppendSeq(sessionId),
      };
      writeRow(stored, message.providerIds ?? [], 'live', userId);
      return { status: 'inserted' as const, message: stored };
    })();
  },

  foldToolResult(
    sessionId: string,
    toolResult: NormalizedMessage,
    transformMerged?: (merged: NormalizedMessage) => NormalizedMessage,
  ): NormalizedMessage | null {
    if (!toolResult.toolId) return null;
    const db = getConnection();
    return db.transaction(() => {
      const dbRow = stmts().findToolUse.get(sessionId, toolResult.toolId) as SessionMessageDatabaseRow | undefined;
      const row = dbRow ? rowToMessage(dbRow) : null;
      if (row) {
        const rawMerged: NormalizedMessage = {
          ...row.payload,
          toolResult: {
            content: toolResult.content,
            isError: Boolean(toolResult.isError),
            toolUseResult: toolResult.toolUseResult,
          },
          ...(toolResult.subagentTools !== undefined
            ? { subagentTools: toolResult.subagentTools }
            : {}),
          seq: row.seq,
        };
        const merged = transformMerged ? { ...transformMerged(rawMerged), seq: row.seq } : rawMerged;
        writeRow(merged, row.providerIds, row.source);
        return merged;
      }
      return null;
    })();
  },

  insertBetween(
    sessionId: string,
    message: NormalizedMessage,
    beforeSeq: number | null,
    afterSeq: number | null,
    source: SessionMessageSource = 'import',
  ): NormalizedMessage {
    const db = getConnection();
    return db.transaction(() => {
      let left = beforeSeq;
      let right = afterSeq;
      let seq: number;

      if (left === null && right === null) {
        seq = nextAppendSeq(sessionId);
      } else if (left === null) {
        seq = right! / 2;
      } else if (right === null) {
        seq = nextAppendSeq(sessionId);
      } else {
        seq = (left + right) / 2;
      }

      if (
        (left !== null && seq <= left)
        || (right !== null && seq >= right)
      ) {
        const existingRows = this.listAll(sessionId);
        const leftRow = left === null
          ? null
          : existingRows.find((row) => row.seq === left) ?? null;
        const rightRow = right === null
          ? null
          : existingRows.find((row) => row.seq === right) ?? null;
        this.renumber(sessionId);
        left = leftRow?.id ? this.getById(sessionId, leftRow.id)?.seq ?? null : null;
        right = rightRow?.id ? this.getById(sessionId, rightRow.id)?.seq ?? null : null;
        if (left !== null && right !== null) seq = (left + right) / 2;
        else if (right !== null) seq = right / 2;
        else seq = nextAppendSeq(sessionId);
      }

      const stored = { ...message, sessionId, seq };
      writeRow(stored, message.providerIds ?? [], source);
      return stored;
    })();
  },

  supplementById(
    sessionId: string,
    message: NormalizedMessage,
  ): NormalizedMessage | null {
    const existing = getRow(sessionId, message.id);
    if (!existing) return null;
    const merged = mergeDefined(existing.payload, message, existing.seq);
    const providerIds = [...new Set([...existing.providerIds, ...(message.providerIds ?? [])])];
    // 對帳每次讀歷史都會走到這裡；內容沒變就不重寫，避免整個會話反覆寫盤
    if (
      providerIds.length === existing.providerIds.length
      && JSON.stringify(merged) === JSON.stringify(existing.payload)
    ) {
      return existing.payload;
    }
    writeRow(merged, providerIds, existing.source);
    return merged;
  },

  updateProviderIds(sessionId: string, id: string, providerIds: string[]): void {
    const existing = getRow(sessionId, id);
    if (!existing) return;
    if (providerIds.every((id) => existing.providerIds.includes(id))) return;
    writeRow(
      existing.payload,
      [...existing.providerIds, ...providerIds],
      existing.source,
    );
  },

  getById: getRow,

  replaceSessionMessages(
    sessionId: string,
    messages: NormalizedMessage[],
    source: SessionMessageSource = 'import',
  ): void {
    const db = getConnection();
    db.transaction(() => {
      stmts().deleteBySession.run(sessionId);
      messages.forEach((message, index) => {
        const stored: NormalizedMessage = {
          ...message,
          id: message.id,
          sessionId,
          seq: index + 1,
        };
        writeRow(stored, stored.providerIds ?? [], source, null);
      });
    })();
  },

  list(sessionId: string, options: SessionMessageListOptions = {}): SessionMessagePage {
    const rows = (stmts().listBySession.all(sessionId) as SessionMessageDatabaseRow[])
      .map(rowToMessage)
      .filter((row): row is SessionMessageRow => Boolean(row));

    let filtered = rows;
    if (options.afterSeq !== undefined && options.afterSeq !== null) {
      filtered = filtered.filter((row) => row.seq > options.afterSeq!);
    }
    if (options.beforeSeq !== undefined && options.beforeSeq !== null) {
      filtered = filtered.filter((row) => row.seq < options.beforeSeq!);
    }

    const total = rows.length;
    const offset = Math.max(0, options.offset ?? 0);
    const end = Math.max(0, filtered.length - offset);
    const limit = options.limit === null || options.limit === undefined
      ? null
      : Math.max(0, options.limit);
    const start = limit === null ? 0 : Math.max(0, end - limit);
    const page = filtered.slice(start, end);
    const hasMore = start > 0;
    return {
      messages: page.map((row) => row.payload),
      rows: page,
      total,
      hasMore,
      nextBeforeSeq: page.length > 0 ? page[0].seq : null,
    };
  },

  listAll(sessionId: string): SessionMessageRow[] {
    return this.list(sessionId).rows;
  },

  maxSeq(sessionId: string): number {
    return nextAppendSeq(sessionId) - 1;
  },

  deleteBySession(sessionId: string): number {
    return stmts().deleteBySession.run(sessionId).changes;
  },

  deleteBySessions(sessionIds: string[]): number {
    if (sessionIds.length === 0) return 0;
    const placeholders = sessionIds.map(() => '?').join(', ');
    return getConnection().prepare(
      `DELETE FROM session_messages WHERE session_id IN (${placeholders})`,
    ).run(...sessionIds).changes;
  },

  renumber(sessionId: string): void {
    const db = getConnection();
    db.transaction(() => {
      const s = stmts();
      const rows = s.selectIdsBySession.all(sessionId) as Array<{ id: string }>;
      if (rows.length === 0) return;
      s.negateSeqBySession.run(sessionId);
      rows.forEach((row, index) => s.updateSeqById.run(index + 1, sessionId, row.id));
    })();
  },

  listSizes(): Array<{
    sessionId: string;
    bytes: number;
    updatedAt: number;
    starred: boolean;
  }> {
    const rows = stmts().listSizes.all() as Array<{
      sessionId: string;
      bytes: number;
      updatedAt: number;
      starred: number;
    }>;
    return rows.map((row) => ({
      sessionId: row.sessionId,
      bytes: Number(row.bytes),
      updatedAt: Number(row.updatedAt),
      starred: Boolean(row.starred),
    }));
  },
};
