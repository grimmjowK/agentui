import type { NormalizedMessage } from '@/shared/types.js';

export type MessageContractKind =
  | 'assistant_text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'compact_boundary'
  | 'interrupted'
  | 'user';

export type MessageIdContractReport = {
  stableHistoryIds: boolean;
  byKind: Record<MessageContractKind, {
    liveOnly: NormalizedMessage[];
    historyOnly: NormalizedMessage[];
    both: NormalizedMessage[];
  }>;
  userPairing: {
    paired: Array<{ live: NormalizedMessage; history: NormalizedMessage }>;
    unpairedLive: NormalizedMessage[];
    unpairedHistory: NormalizedMessage[];
  };
};

const CONTRACT_KINDS: MessageContractKind[] = [
  'assistant_text',
  'tool_use',
  'tool_result',
  'thinking',
  'compact_boundary',
  'interrupted',
  'user',
];

/**
 * Converts the three provider tool-result shapes into the durable log shape:
 * one `tool_use` row with `toolResult` attached.
 */
export function foldToolResultsForContract(messages: NormalizedMessage[]): NormalizedMessage[] {
  const toolUses = new Map(
    messages
      .filter((message) => message.kind === 'tool_use' && message.toolId)
      .map((message) => [message.toolId!, { ...message }]),
  );

  for (const message of messages) {
    if (message.kind !== 'tool_result' || !message.toolId) continue;
    const toolUse = toolUses.get(message.toolId);
    if (!toolUse) continue;
    toolUse.toolResult = {
      content: message.content || '',
      isError: Boolean(message.isError),
      toolUseResult: message.toolUseResult,
    };
    if (message.subagentTools !== undefined) {
      toolUse.subagentTools = message.subagentTools;
    }
  }

  const emitted = new Set<string>();
  const folded: NormalizedMessage[] = [];
  for (const message of messages) {
    if (message.kind === 'tool_result' && message.toolId && toolUses.has(message.toolId)) {
      continue;
    }
    if (message.kind === 'tool_use' && message.toolId) {
      if (emitted.has(message.toolId)) continue;
      emitted.add(message.toolId);
      folded.push(toolUses.get(message.toolId)!);
      continue;
    }
    folded.push(message);
  }
  return folded;
}

export function classifyMessageContract(message: NormalizedMessage): MessageContractKind | null {
  if (message.isInterrupted) return 'interrupted';
  if (message.isCompactBoundary) return 'compact_boundary';
  if (message.kind === 'thinking') return 'thinking';
  if (message.kind === 'tool_use') return 'tool_use';
  if (message.kind === 'tool_result') return 'tool_result';
  if (message.kind === 'text' && message.role === 'assistant') return 'assistant_text';
  if (message.kind === 'text' && message.role === 'user') return 'user';
  return null;
}

/**
 * Compares the ids emitted by a replayed live event stream with the ids parsed
 * from the matching provider transcript. User-message ids intentionally differ
 * between live and history, so those are paired by order within the fixture.
 */
export function buildMessageIdContractReport(
  liveMessages: NormalizedMessage[],
  historyMessages: NormalizedMessage[],
): MessageIdContractReport {
  const byKind = Object.fromEntries(
    CONTRACT_KINDS.map((kind) => [kind, { liveOnly: [], historyOnly: [], both: [] }]),
  ) as unknown as MessageIdContractReport['byKind'];

  for (const kind of CONTRACT_KINDS) {
    const live = liveMessages.filter((message) => classifyMessageContract(message) === kind);
    const history = historyMessages.filter((message) => classifyMessageContract(message) === kind);

    // User and interrupted rows have transport-specific ids. Their contract is
    // positional within a turn, so compare their pairing separately from ids.
    if (kind === 'user' || kind === 'interrupted') {
      const pairedCount = Math.min(live.length, history.length);
      byKind[kind].both.push(...live.slice(0, pairedCount));
      byKind[kind].liveOnly.push(...live.slice(pairedCount));
      byKind[kind].historyOnly.push(...history.slice(pairedCount));
      continue;
    }

    const historyById = new Map(history.map((message) => [message.id, message]));
    const liveIds = new Set(live.map((message) => message.id));

    for (const message of live) {
      const match = historyById.get(message.id);
      if (match) {
        byKind[kind].both.push(message);
      } else {
        byKind[kind].liveOnly.push(message);
      }
    }

    for (const message of history) {
      if (!liveIds.has(message.id)) {
        byKind[kind].historyOnly.push(message);
      }
    }
  }

  const liveUsers = liveMessages.filter((message) => classifyMessageContract(message) === 'user');
  const historyUsers = historyMessages.filter((message) => classifyMessageContract(message) === 'user');
  const pairedCount = Math.min(liveUsers.length, historyUsers.length);
  const paired = Array.from({ length: pairedCount }, (_, index) => ({
    live: liveUsers[index],
    history: historyUsers[index],
  }));

  return {
    stableHistoryIds: CONTRACT_KINDS
      .filter((kind) => kind !== 'user' && kind !== 'interrupted')
      .every(
        (kind) => byKind[kind].liveOnly.length === 0 && byKind[kind].historyOnly.length === 0,
    ),
    byKind,
    userPairing: {
      paired,
      unpairedLive: liveUsers.slice(pairedCount),
      unpairedHistory: historyUsers.slice(pairedCount),
    },
  };
}

/**
 * Reads the same history twice and reports any category whose sequence of ids
 * changed. This catches random ids before they reach reconciliation.
 */
export async function inspectHistoryIdStability(
  readHistory: () => Promise<NormalizedMessage[]>,
): Promise<{
  stable: boolean;
  unstableKinds: MessageContractKind[];
  first: NormalizedMessage[];
  second: NormalizedMessage[];
}> {
  const first = await readHistory();
  const second = await readHistory();
  const unstableKinds = CONTRACT_KINDS.filter((kind) => {
    const firstIds = first
      .filter((message) => classifyMessageContract(message) === kind)
      .map((message) => message.id);
    const secondIds = second
      .filter((message) => classifyMessageContract(message) === kind)
      .map((message) => message.id);
    return firstIds.length !== secondIds.length
      || firstIds.some((id, index) => id !== secondIds[index]);
  });

  return {
    stable: unstableKinds.length === 0,
    unstableKinds,
    first,
    second,
  };
}
