import {
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
  return (message.kind === 'text' && message.role === 'assistant')
    || message.kind === 'tool_use'
    || message.kind === 'thinking';
}

function providerIds(message: NormalizedMessage): string[] {
  return [...new Set([message.id, ...(message.providerIds ?? [])])];
}

function matches(row: SessionMessageRow, message: NormalizedMessage): boolean {
  const ids = new Set(providerIds(message));
  return ids.has(row.id) || (row.providerIds ?? []).some((id) => ids.has(id));
}

function findMatch(
  rows: SessionMessageRow[],
  message: NormalizedMessage,
): SessionMessageRow | undefined {
  return rows.find((row) => matches(row, message));
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
  return rows.map((row) => {
    const rowIds = new Set([row.id, ...(row.providerIds ?? [])]);
    const match = history.find((message) => (
      providerIds(message).some((id) => rowIds.has(id))
    ));
    if (!match || !row.payload.truncated) return row.payload;
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
  for (const message of history) {
    sessionMessagesDb.append(sessionId, {
      ...message,
      sessionId,
      providerIds: providerIds(message),
    }, 'import');
  }
}

export function supportsMessageLogReconciliation(provider: LLMProvider): boolean {
  return RECONCILABLE_PROVIDERS.has(provider);
}

export function rebuildSessionMessageLog(
  sessionId: string,
  history: NormalizedMessage[],
  provider: LLMProvider,
): NormalizedMessage[] {
  const fullHistory = uniqueHistory(history);
  sessionMessagesDb.deleteBySession(sessionId);
  if (supportsMessageLogReconciliation(provider)) {
    fullImport(sessionId, fullHistory);
  } else {
    fullImport(sessionId, fullHistory);
  }
  return sessionMessagesDb.list(sessionId).messages;
}

export function reconcileSessionMessageLog(input: {
  sessionId: string;
  provider: LLMProvider;
  history: NormalizedMessage[];
  active?: boolean;
}): NormalizedMessage[] {
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

  const historicalIds = new Set(history.flatMap(providerIds));
  const diverged = !active
    && history.length > 0
    && journal.some((row) => (
      row.source === 'live'
      && isStableAnchor(row.payload)
      && providerIds(row.payload).some((id) => !historicalIds.has(id))
    ));
  if (diverged) {
    console.warn('[session-message-log] provider history diverged; rebuilding', {
      sessionId,
      provider,
    });
    sessionMessagesDb.deleteBySession(sessionId);
    fullImport(sessionId, history);
    return sessionMessagesDb.list(sessionId).messages;
  }

  journal = sessionMessagesDb.listAll(sessionId);
  const matchedByHistoryIndex = new Map<number, SessionMessageRow>();
  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    const match = findMatch(journal, message);
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
