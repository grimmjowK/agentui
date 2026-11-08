import fsSync from 'node:fs';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';
import { sessionPinService } from '@/modules/providers/services/session-pin.service.js';
import { mapRolloutEntry, type MappedMessage } from '@/modules/providers/list/codex/codex-item-mapper.js';
import { extractCodexSearchableMessages } from '@/modules/providers/list/codex/codex-searchable-messages.js';
import { isInternalUserText, isInterruptedUserText } from '@/modules/providers/shared/session-message-pairing.js';

const PROVIDER = 'codex';

type CodexHistoryResult =
  | AnyRecord[]
  | {
      messages?: AnyRecord[];
      total?: number;
      hasMore?: boolean;
      offset?: number;
      limit?: number | null;
      tokenUsage?: unknown;
    };

export function isCodexInterruptedText(text: string): boolean {
  return isInterruptedUserText(text);
}

function isInternalCodexUserText(text: string): boolean {
  return isInternalUserText(text);
}

function isVisibleCodexUserMessage(payload: AnyRecord | null | undefined): boolean {
  if (!payload) {
    return false;
  }

  if (payload.type === 'user_message') {
    if (payload.kind && payload.kind !== 'plain') {
      return false;
    }
    const msg = typeof payload.message === 'string' ? payload.message : '';
    if (!msg.trim()) return false;
    if (isCodexInterruptedText(msg)) return true;
    return !isInternalCodexUserText(msg);
  }

  // Current Codex rollout files persist user input as response_item/message,
  // not event_msg/user_message. Keep both historical formats visible.
  if (payload.type !== 'message' || payload.role !== 'user') {
    return false;
  }

  const rawText = extractCodexTextContent(payload.content, { excludeInternal: false });
  if (isCodexInterruptedText(rawText)) return true;
  return extractCodexTextContent(payload.content, { excludeInternal: true }).trim().length > 0;
}

function extractCodexTextContent(
  content: unknown,
  options?: { excludeInternal?: boolean },
): string {
  const excludeInternal = options?.excludeInternal ?? false;

  if (!Array.isArray(content)) {
    if (typeof content !== 'string') {
      return '';
    }
    return excludeInternal && isInternalCodexUserText(content) ? '' : content;
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as AnyRecord;
      if (
        (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text')
        && typeof record.text === 'string'
      ) {
        if (excludeInternal && isInternalCodexUserText(record.text)) {
          return '';
        }
        return record.text;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function getCodexSessionMessages(
  sessionId: string,
  limit: number | null = null,
  offset = 0,
): Promise<CodexHistoryResult> {
  try {
    const sessionFilePath = await sessionPinService.resolveTranscriptPath(sessionId);

    if (!sessionFilePath) {
      console.warn(`Codex session file not found for session ${sessionId}`);
      return { messages: [], total: 0, hasMore: false };
    }

    const messages: AnyRecord[] = [];
    const splitToolIds = new Map<string, string[]>();
    let tokenUsage: AnyRecord | null = null;
    let lineIndex = 0;
    const fileStream = fsSync.createReadStream(sessionFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;
        const historyId = `codex_${sessionId}_${lineIndex}`;

        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
          const info = entry.payload.info as AnyRecord;
          if (info.total_token_usage) {
            const usage = info.total_token_usage as AnyRecord;
            tokenUsage = {
              used: usage.total_tokens || 0,
              total: info.model_context_window || 200000,
            };
          }
        }

        if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload as AnyRecord)) {
          const rawMsg = String((entry.payload as AnyRecord).message || '');
          const isInterrupted = isCodexInterruptedText(rawMsg);
          messages.push({
            type: 'user',
            uuid: historyId,
            providerIds: [historyId],
            historyUserFormat: 'event',
            timestamp: entry.timestamp,
            message: {
              role: 'user',
              content: rawMsg,
            },
            ...(isInterrupted ? { isInterrupted: true } : {}),
          });
        }

        if (entry.type === 'response_item' && isVisibleCodexUserMessage(entry.payload as AnyRecord)) {
          const rawContent = extractCodexTextContent(entry.payload.content, { excludeInternal: false });
          const isInterrupted = isCodexInterruptedText(rawContent);
          const visibleContent = isInterrupted
            ? rawContent
            : extractCodexTextContent(entry.payload.content, { excludeInternal: true });
          let matchingEvent: AnyRecord | undefined;
          for (let index = messages.length - 1; index >= 0; index--) {
            const candidate = messages[index];
            if (candidate.type === 'assistant' || candidate.type === 'mapped') {
              break;
            }
            if (
              candidate.type === 'user'
              && candidate.historyUserFormat === 'event'
              && String(candidate.message?.content ?? '') === visibleContent
            ) {
              matchingEvent = candidate;
              break;
            }
          }

          if (matchingEvent) {
            matchingEvent.uuid = historyId;
            matchingEvent.providerIds = [...(matchingEvent.providerIds || []), historyId];
          } else {
            messages.push({
              type: 'user',
              uuid: historyId,
              providerIds: [historyId],
              timestamp: entry.timestamp,
              message: {
                role: 'user',
                content: visibleContent,
              },
              ...(isInterrupted ? { isInterrupted: true } : {}),
            });
          }
        }

        if (
          entry.type === 'response_item' &&
          entry.payload?.type === 'message' &&
          entry.payload.role === 'assistant'
        ) {
          const rawContent = extractCodexTextContent(entry.payload.content, { excludeInternal: false });
          if (isCodexInterruptedText(rawContent)) {
            messages.push({
              type: 'user',
              uuid: historyId,
              providerIds: [historyId],
              timestamp: entry.timestamp,
              message: {
                role: 'user',
                content: rawContent,
              },
              isInterrupted: true,
            });
          } else {
            const textContent = extractCodexTextContent(entry.payload.content, { excludeInternal: true });
            if (textContent.trim()) {
              messages.push({
                type: 'assistant',
                // payload.id 即 app-server 即時事件的 item.id（id 契約）
                uuid: typeof entry.payload.id === 'string' && entry.payload.id
                  ? entry.payload.id
                  : historyId,
                timestamp: entry.timestamp,
                message: {
                  role: 'assistant',
                  content: textContent,
                },
              });
            }
          }
        }

        for (const mapped of mapRolloutEntry(entry, splitToolIds, { sessionId, lineIndex })) {
          messages.push({ type: 'mapped', timestamp: entry.timestamp, mapped });
        }
      } catch {
        // Skip malformed lines.
      }
      lineIndex += 1;
    }

    messages.sort(
      (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
    );
    const total = messages.length;

    if (limit !== null) {
      const startIndex = Math.max(0, total - offset - limit);
      const endIndex = total - offset;
      const paginatedMessages = messages.slice(startIndex, endIndex);
      const hasMore = startIndex > 0;

      return {
        messages: paginatedMessages,
        total,
        hasMore,
        offset,
        limit,
        tokenUsage,
      };
    }

    return { messages, tokenUsage };
  } catch (error) {
    console.error(`Error reading Codex session messages for ${sessionId}:`, error);
    return { messages: [], total: 0, hasMore: false };
  }
}

export class CodexSessionsProvider implements IProviderSessions {
  extractSearchableMessages = extractCodexSearchableMessages;

  /**
   * Normalizes a persisted Codex JSONL entry.
   *
   * Tool-related rollout entries arrive pre-mapped (`type: 'mapped'`) from
   * codex-item-mapper; user/assistant text uses a compact message shape.
   */
  private normalizeHistoryEntry(raw: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');
    const providerIds = Array.isArray(raw.providerIds) ? raw.providerIds : undefined;

    if (raw.type === 'mapped') {
      const mapped = raw.mapped as MappedMessage;
      return [createNormalizedMessage({
        ...mapped,
        kind: mapped.kind as NormalizedMessage['kind'],
        // tool_use 以 toolId（rollout call_id，等於即時 item.id）為 id，與即時訊息對齊
        id: mapped.id
          || (mapped.kind === 'tool_use' && typeof mapped.toolId === 'string' && mapped.toolId)
          || (mapped.kind === 'tool_result' && typeof mapped.toolId === 'string' && `${mapped.toolId}:result`)
          || baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        ...(providerIds ? { providerIds } : {}),
      })];
    }

    if (raw.type === 'thinking' || raw.isReasoning) {
      const thinkingContent = typeof raw.message?.content === 'string'
        ? raw.message.content
        : '';
      if (!thinkingContent.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: thinkingContent,
        ...(providerIds ? { providerIds } : {}),
      })];
    }

    if (raw.message?.role === 'user') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : String(raw.message.content || '');
      if (!content.trim()) {
        return [];
      }
      const isInterrupted = Boolean(raw.isInterrupted) || isCodexInterruptedText(content);
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content,
        ...(isInterrupted ? { isInterrupted: true } : {}),
        ...(providerIds ? { providerIds } : {}),
      })];
    }

    if (raw.message?.role === 'assistant') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : '';
      if (!content.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content,
        ...(providerIds ? { providerIds } : {}),
      })];
    }

    if (raw.type === 'tool_use' || raw.toolName) {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName || 'Unknown',
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      })];
    }

    if (raw.type === 'tool_result') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: Boolean(raw.isError),
      })];
    }

    return [];
  }

  /**
   * Normalizes a Codex history entry. Live events are mapped in openai-codex.ts
   * via codex-item-mapper and never reach this method.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (raw.type === 'mapped' || raw.message?.role || raw.type === 'tool_use' || raw.type === 'tool_result' || raw.type === 'thinking' || raw.toolName) {
      return this.normalizeHistoryEntry(raw, sessionId);
    }

    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'turn_complete') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'complete',
      })];
    }
    if (raw.type === 'turn_failed') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'error',
        content: raw.error?.message || 'Turn failed',
      })];
    }

    return [];
  }

  /**
   * Loads Codex JSONL history and keeps token usage metadata when projects.js
   * provides it.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    let result: CodexHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getCodexSessionMessages(sessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodexProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);
    const tokenUsage = Array.isArray(result) ? undefined : result.tokenUsage;

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeHistoryEntry(raw, sessionId));
    }

    const toolResultMap = new Map<string, NormalizedMessage>();
    for (const msg of normalized) {
      if (msg.kind === 'tool_result' && msg.toolId) {
        toolResultMap.set(msg.toolId, msg);
      }
    }
    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (toolResult) {
          msg.toolResult = { content: toolResult.content, isError: toolResult.isError };
        }
      }
    }

    const totalNormalized = normalized.length;
    let total = 0;
    for (const msg of normalized) {
      if (msg.kind !== 'tool_result') {
        total += 1;
      }
    }
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const messages = normalizedLimit === null
      ? normalized
      : normalized.slice(
          Math.max(0, totalNormalized - normalizedOffset - normalizedLimit),
          Math.max(0, totalNormalized - normalizedOffset),
        );
    const hasMore = normalizedLimit === null
      ? false
      : Math.max(0, totalNormalized - normalizedOffset - normalizedLimit) > 0;

    return {
      messages,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      tokenUsage,
    };
  }
}
