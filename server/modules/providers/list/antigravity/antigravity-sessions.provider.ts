import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId } from '@/shared/utils.js';
import { sessionPinService } from '@/modules/providers/services/session-pin.service.js';

const PROVIDER = 'antigravity';

export class AntigravitySessionsProvider implements IProviderSessions {
  /**
   * Normalizes live events or raw messages into standard NormalizedMessage format.
   */
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    if (!raw || typeof raw !== 'object') {
      return [];
    }

    const record = raw as AnyRecord;

    // Already normalized message
    if (record.kind && (record.kind === 'text' || record.kind === 'tool_use' || record.kind === 'tool_result' || record.kind === 'error')) {
      return [
        createNormalizedMessage({
          kind: record.kind as NormalizedMessage['kind'],
          provider: PROVIDER,
          sessionId: sessionId || (typeof record.sessionId === 'string' ? record.sessionId : null),
          ...record,
        }),
      ];
    }

    // Standard assistant text
    if (typeof record.text === 'string' && record.text.trim()) {
      return [
        createNormalizedMessage({
          id: generateMessageId('agy_msg'),
          sessionId,
          provider: PROVIDER,
          kind: 'text',
          role: (record.role as 'user' | 'assistant') || 'assistant',
          content: record.text,
        }),
      ];
    }

    return [];
  }

  /**
   * Loads session history from the native transcript JSONL file.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    if (limit === 0) {
      return { messages: [], total: 0, hasMore: false, offset, limit: 0 };
    }

    let sessionFilePath = await sessionPinService.resolveTranscriptPath(sessionId);
    if (!sessionFilePath) {
      const candidateRoots = [
        path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
        path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
      ];
      if (process.env.ANTIGRAVITY_HOME) {
        candidateRoots.unshift(path.join(process.env.ANTIGRAVITY_HOME, 'brain'));
      }
      for (const root of candidateRoots) {
        let candidate = path.join(root, sessionId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fsSync.existsSync(candidate)) {
          candidate = path.join(root, sessionId, 'transcript.jsonl');
        }
        if (fsSync.existsSync(candidate)) {
          sessionFilePath = candidate;
          break;
        }
      }
    }
    if (!sessionFilePath) {
      return { messages: [], total: 0, hasMore: false, offset, limit };
    }

    const normalized: NormalizedMessage[] = [];

    try {
      const fileStream = fsSync.createReadStream(sessionFilePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      let lineIndex = 0;

      for await (const line of rl) {
        if (!line.trim()) continue;
        lineIndex += 1;

        try {
          const entry = JSON.parse(line) as AnyRecord;
          const baseId = `agy_${sessionId}_${lineIndex}`;
          const tsStr = entry.created_at ? new Date(String(entry.created_at)).toISOString() : new Date().toISOString();

          // 1. Antigravity transcript format
          // USER_INPUT step
          if (entry.type === 'USER_INPUT' || entry.source === 'USER_EXPLICIT') {
            let content = typeof entry.content === 'string' ? entry.content : '';
            const requestMatch = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (requestMatch) {
              content = requestMatch[1].trim();
            }
            if (content.trim()) {
              normalized.push(
                createNormalizedMessage({
                  id: `${baseId}_user`,
                  sessionId,
                  timestamp: tsStr,
                  provider: PROVIDER,
                  kind: 'text',
                  role: 'user',
                  content,
                }),
              );
            }
            continue;
          }

          // Skip generic execution output
          if (entry.type === 'GENERIC') {
            continue;
          }

          // PLANNER_RESPONSE / MODEL step
          if (entry.type === 'PLANNER_RESPONSE' || entry.source === 'MODEL' || entry.role === 'assistant') {
            const content = typeof entry.content === 'string' ? entry.content : '';
            if (content.trim()) {
              normalized.push(
                createNormalizedMessage({
                  id: `${baseId}_model`,
                  sessionId,
                  timestamp: tsStr,
                  provider: PROVIDER,
                  kind: 'text',
                  role: 'assistant',
                  content,
                }),
              );
            }

            // Tool calls
            if (Array.isArray(entry.tool_calls)) {
              for (let i = 0; i < entry.tool_calls.length; i++) {
                const call = entry.tool_calls[i] as AnyRecord;
                if (!call) continue;
                const toolName = typeof call.name === 'string' ? call.name : (call.toolName as string) || 'tool';
                const toolInput = call.args || call.toolInput || {};
                const toolId = (call.id as string) || `${baseId}_tool_${i}`;

                normalized.push(
                  createNormalizedMessage({
                    id: `${baseId}_call_${i}`,
                    sessionId,
                    timestamp: tsStr,
                    provider: PROVIDER,
                    kind: 'tool_use',
                    toolName,
                    toolInput,
                    toolId,
                  }),
                );
              }
            }
            continue;
          }

          // 2. Generic / Gemini JSONL format
          const role = entry.role === 'user' ? 'user' : 'assistant';
          const content = typeof entry.content === 'string' ? entry.content : '';
          if (content.trim()) {
            normalized.push(
              createNormalizedMessage({
                id: `${baseId}_content`,
                sessionId,
                timestamp: tsStr,
                provider: PROVIDER,
                kind: 'text',
                role,
                content,
              }),
            );
          }
        } catch {
          // Ignore malformed line
        }
      }
    } catch (error) {
      console.warn(`Failed to read Antigravity transcript for ${sessionId}:`, error);
      return { messages: [], total: 0, hasMore: false, offset, limit };
    }

    const start = Math.max(0, offset);
    const pageLimit = limit === null ? null : Math.max(0, limit);
    // Offset counts backwards from the newest message, matching fetchMore's
    // prepend contract while keeping each returned page chronological.
    const end = Math.max(0, normalized.length - start);
    const begin = pageLimit === null ? 0 : Math.max(0, end - pageLimit);
    const messages = normalized.slice(begin, end);

    return {
      messages,
      total: normalized.length,
      hasMore: begin > 0,
      offset: start,
      limit: pageLimit,
    };
  }
}
