import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
  shouldKeepExistingSessionName,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

type SessionTitles = {
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  all: string[];
};

const UNTITLED = 'Untitled Claude Session';

/**
 * sub-agent 的转录写在 `<主会话 id>/subagents/agent-*.jsonl`，每行的 `sessionId`
 * 都等于父会话 id（`isSidechain: true`），`cwd` 却是 sub-agent 自己的工作目录。
 * 不挡掉的话，createSession 的 upsert 会把父会话的 `jsonl_path` 和 `project_path`
 * 一起覆盖成 sub-agent 的——聊天页只剩 sub-agent 那段上下文，会话还会从原项目
 * 消失、在 projects 表里凭空长出一个幽灵项目。
 */
function isSubagentTranscript(filePath: string): boolean {
  return filePath.split(path.sep).includes('subagents');
}

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    if (isSubagentTranscript(filePath)) {
      return null;
    }

    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    const existingSession = sessionsDb.getSessionById(parsed.sessionId);
    if (existingSession?.name_is_custom === 1 && existingSession.custom_name) {
      return { ...parsed, sessionName: existingSession.custom_name };
    }

    const titles = await this.readSessionTitles(filePath, parsed.sessionId);
    const historyName = nameMap.get(parsed.sessionId);
    if (shouldKeepExistingSessionName(existingSession, [...titles.all, historyName], UNTITLED)) {
      return { ...parsed, sessionName: existingSession!.custom_name! };
    }

    // CLI /rename > Claude 自動生成的標題 > 首句提問 > 最後一句提問
    return {
      ...parsed,
      sessionName: normalizeSessionName(
        titles.customTitle ?? titles.aiTitle ?? historyName ?? titles.lastPrompt,
        UNTITLED,
      ),
    };
  }

  /** 取各類標題事件的最新值；all 收集所有出現過的值，供判斷舊資料的名稱是否為自動產生。 */
  private async readSessionTitles(filePath: string, sessionId: string): Promise<SessionTitles> {
    const result: SessionTitles = { all: [] };
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      // Ignore missing/unreadable files so sync can continue.
      return result;
    }

    for (const line of content.split(/\r?\n/)) {
      // 先用字串篩掉絕大多數訊息行，避免整檔逐行 JSON.parse
      const field = line.includes('"type":"ai-title"') ? 'aiTitle'
        : line.includes('"type":"last-prompt"') ? 'lastPrompt'
          : line.includes('"type":"custom-title"') ? 'customTitle'
            : null;
      if (!field) continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const value = data[field];
      if (data.sessionId === sessionId && typeof value === 'string' && value.trim()) {
        result[field] = value;
        result.all.push(value);
      }
    }
    return result;
  }
}
