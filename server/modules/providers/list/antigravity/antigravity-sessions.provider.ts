import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions, SearchableMessage, SessionArtifact } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readJsonlEntries } from '@/shared/utils.js';
import { sessionPinService } from '@/modules/providers/services/session-pin.service.js';
import {
  agyToolId,
  decodeTranscriptArgs,
  isAgyToolError,
  mapAgyTool,
  stripStepHeader,
} from '@/modules/providers/list/antigravity/antigravity-tool-mapper.js';

const PROVIDER = 'antigravity';

/** brain 根目錄候選；ANTIGRAVITY_HOME 優先。 */
function brainRoots(): string[] {
  const roots = [
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
  ];
  if (process.env.ANTIGRAVITY_HOME) {
    roots.unshift(path.join(process.env.ANTIGRAVITY_HOME, 'brain'));
  }
  return roots;
}

const isInside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * 只讀 `brain/<sessionId>/` 頂層的 `.md`（實測只有 task.md，附 .metadata.json），
 * 子目錄（.system_generated、scratch、.user_uploaded）一律不看。
 * 每個檔案以 realpath 解析後必須仍在 brain 根目錄內，指向外部的符號連結會被略過。
 */
export async function listBrainArtifacts(sessionId: string, roots: string[] = brainRoots()): Promise<SessionArtifact[]> {
  for (const root of roots) {
    let realRoot: string;
    let realDir: string;
    try {
      realRoot = await fsSync.promises.realpath(root);
      realDir = await fsSync.promises.realpath(path.join(root, sessionId));
    } catch {
      continue;
    }
    if (!isInside(realRoot, realDir)) return [];

    const artifacts: SessionArtifact[] = [];
    for (const entry of await fsSync.promises.readdir(realDir, { withFileTypes: true })) {
      if (!entry.name.endsWith('.md') || entry.isDirectory()) continue;
      try {
        const realFile = await fsSync.promises.realpath(path.join(realDir, entry.name));
        if (!isInside(realRoot, realFile)) continue;
        const stat = await fsSync.promises.stat(realFile);
        if (!stat.isFile()) continue;
        const content = await fsSync.promises.readFile(realFile, 'utf8');
        const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
        artifacts.push({
          id: entry.name,
          title: heading || entry.name.replace(/\.md$/, ''),
          fileName: entry.name,
          updatedAt: stat.mtime.toISOString(),
          content,
        });
      } catch {
        // 讀取期間被刪除或權限不足：略過這個檔案
      }
    }
    return artifacts.sort((left, right) => left.fileName.localeCompare(right.fileName));
  }
  return [];
}

/** USER_INPUT 的內容包在 `<USER_REQUEST>` 裡，外層還有系統附加的中繼資料。 */
function readUserRequest(content: unknown): string {
  const text = typeof content === 'string' ? content : '';
  const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return match ? match[1].trim() : text;
}

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
   * 搜尋只看使用者輸入（USER_INPUT）與模型回覆（PLANNER_RESPONSE 的 content），
   * 不含工具輸出（GENERIC）與系統訊息。
   */
  async *extractSearchableMessages(filePath: string): AsyncGenerator<SearchableMessage> {
    for await (const entry of readJsonlEntries(filePath)) {
      const timestamp = entry.created_at ? String(entry.created_at) : null;
      if (entry.type === 'USER_INPUT') {
        const text = readUserRequest(entry.content);
        if (text.trim()) {
          yield { role: 'user', text, timestamp };
        }
      } else if (entry.type === 'PLANNER_RESPONSE' && typeof entry.content === 'string' && entry.content.trim()) {
        yield { role: 'assistant', text: entry.content, timestamp };
      }
    }
  }

  listArtifacts(sessionId: string): Promise<SessionArtifact[]> {
    return listBrainArtifacts(sessionId);
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
      for (const root of brainRoots()) {
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
    const toolResults = new Map<string, { content: string; isError: boolean }>();

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
          // CLI 寫給模型的系統通知（例如續接時「伺服器重啟、子 agent 已停止」），不是對話內容
          if (entry.type === 'SYSTEM_MESSAGE' || entry.source === 'SYSTEM') {
            continue;
          }

          // USER_INPUT step
          if (entry.type === 'USER_INPUT' || entry.source === 'USER_EXPLICIT') {
            const content = readUserRequest(entry.content);
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

          // GENERIC 步驟是工具輸出，以 step_index 配對回 tool_use
          if (entry.type === 'GENERIC') {
            const output = stripStepHeader(typeof entry.content === 'string' ? entry.content : '');
            toolResults.set(agyToolId(entry.step_index), {
              content: output,
              isError: isAgyToolError(entry.status, output),
            });
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
                const { toolName, toolInput } = mapAgyTool(
                  typeof call.name === 'string' ? call.name : '',
                  decodeTranscriptArgs(call.args),
                );
                // 第 k 個呼叫的結果在第 step_index + 1 + k 步，與即時 step_update 的 step_index 相同
                const toolId = typeof entry.step_index === 'number'
                  ? agyToolId(entry.step_index + 1 + i)
                  : `${baseId}_tool_${i}`;

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

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResults.has(msg.toolId)) {
        msg.toolResult = toolResults.get(msg.toolId);
      }
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
