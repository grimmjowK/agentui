import {
  getConnection,
  sessionMessagesDb,
  type SessionMessageRow,
} from '@/modules/database/index.js';
import {
  isSessionLogActive,
  truncateMessagePayload,
} from '@/modules/websocket/index.js';
import { isNonPairingUserMessage } from '@/modules/providers/shared/session-message-pairing.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';

const RECONCILABLE_PROVIDERS = new Set<LLMProvider>(['claude', 'codex', 'antigravity']);

function isUserMessage(message: NormalizedMessage): boolean {
  return message.kind === 'text' && message.role === 'user';
}

function isStableAnchor(message: NormalizedMessage): boolean {
  if (message.isInterrupted || message.isCompactBoundary || isUserMessage(message)) {
    return false;
  }
  if (typeof message.parentToolUseId === 'string' && message.parentToolUseId.length > 0) {
    return false;
  }
  return (message.kind === 'text' && message.role === 'assistant')
    || message.kind === 'tool_use'
    || message.kind === 'thinking';
}

function providerIds(message: NormalizedMessage): string[] {
  return [...new Set([message.id, ...(message.providerIds ?? [])])];
}

function rowStableIds(row: SessionMessageRow): string[] {
  return [...new Set([row.id, ...(row.providerIds ?? []), ...providerIds(row.payload)])];
}

function collectHistoricalIds(history: NormalizedMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of history) {
    for (const id of providerIds(message)) {
      ids.add(id);
    }
    if (Array.isArray(message.subagentTools)) {
      for (const sub of message.subagentTools) {
        if (sub && typeof sub === 'object') {
          const record = sub as Record<string, unknown>;
          if (typeof record.id === 'string' && record.id) ids.add(record.id);
          if (typeof record.toolId === 'string' && record.toolId) ids.add(record.toolId);
        }
      }
    }
  }
  return ids;
}

/** id/providerId → row 索引，讓逐條歷史比對從 O(N) 降到 O(1)。 */
function indexRows(rows: SessionMessageRow[]): Map<string, SessionMessageRow> {
  const index = new Map<string, SessionMessageRow>();
  for (const row of rows) {
    for (const id of [row.id, ...(row.providerIds ?? [])]) {
      if (!index.has(id)) index.set(id, row);
    }
  }
  return index;
}

function findMatch(
  index: Map<string, SessionMessageRow>,
  message: NormalizedMessage,
): SessionMessageRow | undefined {
  for (const id of providerIds(message)) {
    const row = index.get(id);
    if (row) return row;
  }
  return undefined;
}

function uniqueHistory(messages: NormalizedMessage[]): NormalizedMessage[] {
  const ids = new Set<string>();
  return messages.filter((message) => {
    if (message.kind === 'tool_result') return false;
    const key = providerIds(message).sort().join('\u0000');
    if (ids.has(key)) return false;
    ids.add(key);
    return true;
  });
}

function overlayFullHistory(
  rows: SessionMessageRow[],
  history: NormalizedMessage[],
): NormalizedMessage[] {
  const historyById = new Map<string, NormalizedMessage>();
  for (const message of history) {
    for (const id of providerIds(message)) {
      if (!historyById.has(id)) historyById.set(id, message);
    }
  }
  return rows.map((row) => {
    if (!row.payload.truncated) return row.payload;
    const match = [row.id, ...(row.providerIds ?? [])]
      .map((id) => historyById.get(id))
      .find(Boolean);
    if (!match) return row.payload;
    return {
      ...row.payload,
      ...match,
      id: row.payload.id,
      sessionId: row.payload.sessionId,
      seq: row.seq,
    };
  });
}

function fullImport(sessionId: string, history: NormalizedMessage[]): void {
  sessionMessagesDb.replaceSessionMessages(
    sessionId,
    history.map((message) => ({
      ...message,
      sessionId,
      providerIds: providerIds(message),
    })),
    'import',
  );
}

export function supportsMessageLogReconciliation(provider: LLMProvider): boolean {
  return RECONCILABLE_PROVIDERS.has(provider);
}

export function rebuildSessionMessageLog(
  sessionId: string,
  history: NormalizedMessage[],
  _provider: LLMProvider,
): NormalizedMessage[] {
  const fullHistory = uniqueHistory(history);
  fullImport(sessionId, fullHistory);
  return sessionMessagesDb.list(sessionId).messages;
}

type ReconcileInput = {
  sessionId: string;
  provider: LLMProvider;
  history: NormalizedMessage[];
  active?: boolean;
};

/** 整段對帳在單一 transaction 內完成：中途失敗不會留下半套日誌，批量寫入也快得多。 */
export function reconcileSessionMessageLog(input: ReconcileInput): NormalizedMessage[] {
  return getConnection().transaction(() => reconcileInTransaction(input))();
}

function reconcileInTransaction(input: ReconcileInput): NormalizedMessage[] {
  const { sessionId, provider } = input;
  const active = input.active ?? isSessionLogActive(sessionId);
  const history = uniqueHistory(input.history);
  let journal = sessionMessagesDb.listAll(sessionId);

  if (journal.length === 0) {
    fullImport(sessionId, history);
    return sessionMessagesDb.list(sessionId).messages;
  }

  if (!supportsMessageLogReconciliation(provider)) {
    return overlayFullHistory(journal, history);
  }

  const historicalIds = collectHistoricalIds(history);
  const diverged = !active
    && history.length > 0
    && journal.some((row) => {
      if (isStableAnchor(row.payload)) {
        return rowStableIds(row).some((id) => !historicalIds.has(id));
      }
      if (row.providerIds.length > 0) {
        return row.providerIds.some((id) => !historicalIds.has(id));
      }
      return false;
    });
  if (diverged) {
    console.warn('[session-message-log] provider history diverged; rebuilding', {
      sessionId,
      provider,
    });
    fullImport(sessionId, history);
    return sessionMessagesDb.list(sessionId).messages;
  }

  journal = sessionMessagesDb.listAll(sessionId);
  const journalIndex = indexRows(journal);
  const matchedByHistoryIndex = new Map<number, SessionMessageRow>();
  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    const match = findMatch(journalIndex, message);
    if (!match) continue;
    matchedByHistoryIndex.set(index, match);
    if (isUserMessage(message)) {
      sessionMessagesDb.updateProviderIds(sessionId, match.id, providerIds(message));
    } else {
      const supplemented = sessionMessagesDb.supplementById(
        sessionId,
        truncateMessagePayload({
          ...message,
          id: match.id,
          sessionId,
        }),
      );
      if (supplemented) {
        matchedByHistoryIndex.set(index, {
          ...match,
          payload: supplemented,
        });
      }
    }
  }

  if (active) {
    journal = sessionMessagesDb.listAll(sessionId);
    return overlayFullHistory(journal, history);
  }

  const previousMatchedSeq = new Map<number, number | null>();
  let lastSeq: number | null = null;
  for (let index = 0; index < history.length; index++) {
    previousMatchedSeq.set(index, lastSeq);
    const match = matchedByHistoryIndex.get(index);
    if (match) lastSeq = match.seq;
  }

  const nextMatchedSeq = new Map<number, number | null>();
  let nextSeq: number | null = null;
  for (let index = history.length - 1; index >= 0; index--) {
    nextMatchedSeq.set(index, nextSeq);
    const match = matchedByHistoryIndex.get(index);
    if (match) nextSeq = match.seq;
  }

  const pairedSpecialHistoryIndexes = new Set<number>();
  const consumedJournalIds = new Set(
    [...matchedByHistoryIndex.values()].map((row) => row.id),
  );
  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    if (!message.isInterrupted && !message.isCompactBoundary) continue;
    const lower = previousMatchedSeq.get(index) ?? Number.NEGATIVE_INFINITY;
    const upper = nextMatchedSeq.get(index) ?? Number.POSITIVE_INFINITY;
    const candidate = journal.find((row) => (
      !consumedJournalIds.has(row.id)
      && row.seq > lower
      && row.seq < upper
      && (
        message.isInterrupted
          ? row.payload.isInterrupted === true
          : row.payload.isCompactBoundary === true
      )
    ));
    if (!candidate) continue;
    consumedJournalIds.add(candidate.id);
    pairedSpecialHistoryIndexes.add(index);
    sessionMessagesDb.updateProviderIds(sessionId, candidate.id, providerIds(message));
  }

  const userHistoryBySegment = new Map<string, number[]>();
  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    if (!isUserMessage(message) || isNonPairingUserMessage(message)) {
      continue;
    }
    const segmentKey = `${previousMatchedSeq.get(index) ?? ''}:${nextMatchedSeq.get(index) ?? ''}`;
    const existing = userHistoryBySegment.get(segmentKey) ?? [];
    existing.push(index);
    userHistoryBySegment.set(segmentKey, existing);
  }

  const pairedHistoryUserIndexes = new Set<number>();
  const importedHistoryUserIndexes = new Set<number>();

  for (const indexes of userHistoryBySegment.values()) {
    const first = indexes[0];
    const lower = previousMatchedSeq.get(first) ?? Number.NEGATIVE_INFINITY;
    const upper = nextMatchedSeq.get(first) ?? Number.POSITIVE_INFINITY;
    const liveUsers = journal.filter((row) => (
      row.source === 'live'
      && isUserMessage(row.payload)
      && !isNonPairingUserMessage(row.payload)
      && row.seq > lower
      && row.seq < upper
      && !matchedByHistoryIndexHasRow(matchedByHistoryIndex, row.id)
    ));

    if (liveUsers.length === 0) {
      indexes.forEach((index) => importedHistoryUserIndexes.add(index));
      continue;
    }
    if (liveUsers.length !== indexes.length) {
      console.warn('[session-message-log] user-message segment counts differ; keeping journal unchanged', {
        sessionId,
        liveCount: liveUsers.length,
        historyCount: indexes.length,
      });
      indexes.forEach((index) => pairedHistoryUserIndexes.add(index));
      continue;
    }
    indexes.forEach((historyIndex, pairIndex) => {
      const live = liveUsers[pairIndex];
      const historyMessage = history[historyIndex];
      sessionMessagesDb.updateProviderIds(sessionId, live.id, providerIds(historyMessage));
      pairedHistoryUserIndexes.add(historyIndex);
    });
  }

  let insertionLeft = previousMatchedSeq.get(0) ?? null;
  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    if (
      matchedByHistoryIndex.has(index)
      || pairedHistoryUserIndexes.has(index)
      || pairedSpecialHistoryIndexes.has(index)
    ) {
      insertionLeft = matchedByHistoryIndex.get(index)?.seq ?? insertionLeft ?? null;
      continue;
    }

    if (isUserMessage(message)) {
      if (isNonPairingUserMessage(message) || importedHistoryUserIndexes.has(index)) {
        const inserted = sessionMessagesDb.insertBetween(
          sessionId,
          { ...message, sessionId, providerIds: providerIds(message) },
          insertionLeft,
          nextMatchedSeq.get(index) ?? null,
          'import',
        );
        insertionLeft = inserted.seq ?? insertionLeft;
      }
      continue;
    }

    const inserted = sessionMessagesDb.insertBetween(
      sessionId,
      { ...message, sessionId, providerIds: providerIds(message) },
      insertionLeft,
      nextMatchedSeq.get(index) ?? null,
      'import',
    );
    insertionLeft = inserted.seq ?? insertionLeft;
  }

  journal = sessionMessagesDb.listAll(sessionId);
  return overlayFullHistory(journal, history);
}

function matchedByHistoryIndexHasRow(
  matches: Map<number, SessionMessageRow>,
  rowId: string,
): boolean {
  for (const row of matches.values()) {
    if (row.id === rowId) return true;
  }
  return false;
}
