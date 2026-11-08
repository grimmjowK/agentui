import { getConnection } from '@/modules/database/connection.js';
import type { NormalizedMessage } from '@/shared/types.js';

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

function writeRow(
  message: NormalizedMessage,
  providerIds: string[],
  source: SessionMessageSource,
  auditUserId?: string | number | null,
): void {
  const db = getConnection();
  const timestamp = now();
  const payload = auditUserId === undefined || auditUserId === null
    ? message
    : { ...message, _logUserId: auditUserId };
  db.prepare(
    `INSERT INTO session_messages
       (session_id, id, seq, provider_ids, payload, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, id) DO UPDATE SET
       provider_ids = excluded.provider_ids,
       payload = excluded.payload,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  ).run(
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
  const db = getConnection();
  const row = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_messages WHERE session_id = ?',
  ).get(sessionId) as { max_seq: number };
  return Math.floor(Number(row.max_seq) || 0) + 1;
}

function getRow(sessionId: string, id: string): SessionMessageRow | null {
  const db = getConnection();
  const row = db.prepare(
    `SELECT session_id, id, seq, provider_ids, payload, source, created_at, updated_at
     FROM session_messages
     WHERE session_id = ? AND id = ?`,
  ).get(sessionId, id) as SessionMessageDatabaseRow | undefined;
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
      const sameId = db.prepare(
        `SELECT session_id, id, seq, provider_ids, payload, source, created_at, updated_at
         FROM session_messages
         WHERE id = ?
         LIMIT 2`,
      ).all(message.id) as SessionMessageDatabaseRow[];

      const existing = sameId.map(rowToMessage).find((entry): entry is SessionMessageRow => Boolean(entry));
      if (existing) {
        const auditUserId = (() => {
          try {
            return JSON.parse((sameId.find((row) => row.session_id === sessionId)?.payload) || '{}')._logUserId;
          } catch {
            return null;
          }
        })();
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
  ): NormalizedMessage | null {
    if (!toolResult.toolId) return null;
    const db = getConnection();
    return db.transaction(() => {
      const rows = db.prepare(
        `SELECT session_id, id, seq, provider_ids, payload, source, created_at, updated_at
         FROM session_messages
         WHERE session_id = ?
         ORDER BY seq ASC`,
      ).all(sessionId) as SessionMessageDatabaseRow[];
      for (const dbRow of rows) {
        const row = rowToMessage(dbRow);
        if (
          row?.payload.kind === 'tool_use'
          && row.payload.toolId === toolResult.toolId
        ) {
          const merged: NormalizedMessage = {
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
          writeRow(merged, row.providerIds, row.source);
          return merged;
        }
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
    writeRow(
      merged,
      [...existing.providerIds, ...(message.providerIds ?? [])],
      existing.source,
    );
    return merged;
  },

  updateProviderIds(sessionId: string, id: string, providerIds: string[]): void {
    const existing = getRow(sessionId, id);
    if (!existing) return;
    writeRow(
      existing.payload,
      [...existing.providerIds, ...providerIds],
      existing.source,
    );
  },

  getById: getRow,

  list(sessionId: string, options: SessionMessageListOptions = {}): SessionMessagePage {
    const db = getConnection();
    const rows = (db.prepare(
      `SELECT session_id, id, seq, provider_ids, payload, source, created_at, updated_at
       FROM session_messages
       WHERE session_id = ?
       ORDER BY seq ASC`,
    ).all(sessionId) as SessionMessageDatabaseRow[])
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
    return getConnection().prepare(
      'DELETE FROM session_messages WHERE session_id = ?',
    ).run(sessionId).changes;
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
      const rows = db.prepare(
        'SELECT id FROM session_messages WHERE session_id = ? ORDER BY seq ASC, id ASC',
      ).all(sessionId) as Array<{ id: string }>;
      if (rows.length === 0) return;
      db.prepare(
        'UPDATE session_messages SET seq = -seq WHERE session_id = ?',
      ).run(sessionId);
      const update = db.prepare(
        'UPDATE session_messages SET seq = ? WHERE session_id = ? AND id = ?',
      );
      rows.forEach((row, index) => update.run(index + 1, sessionId, row.id));
    })();
  },

  listSizes(): Array<{
    sessionId: string;
    bytes: number;
    updatedAt: number;
    starred: boolean;
  }> {
    const rows = getConnection().prepare(
      `SELECT
         sm.session_id AS sessionId,
         SUM(length(sm.payload)) AS bytes,
         MAX(sm.updated_at) AS updatedAt,
         COALESCE(s.isStarred, 0) AS starred
       FROM session_messages sm
       LEFT JOIN sessions s ON s.session_id = sm.session_id
       GROUP BY sm.session_id
       ORDER BY updatedAt ASC`,
    ).all() as Array<{
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
