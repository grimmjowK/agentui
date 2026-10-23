import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { resolveCodexConfigRoot } from '@/shared/codex-cli-path.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  isSubagent?: boolean;
};

export function parseCodexSessionMetadata(rawData: unknown): ParsedSession | null {
  const data = rawData as Record<string, unknown>;
  const payload = data?.payload as Record<string, unknown> | undefined;
  if (!payload) return null;
  const sessionId = typeof payload.id === 'string' ? payload.id : undefined;
  const projectPath = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  if (!sessionId || !projectPath) return null;

  const source = payload.source;
  const sourceIsSubagent = Boolean(
    source
    && typeof source === 'object'
    && !Array.isArray(source)
    && (
      Object.hasOwn(source, 'subagent')
      || Object.hasOwn(source, 'subAgent')
      || Object.hasOwn(source, 'sub_agent')
    )
  );

  return {
    sessionId,
    projectPath,
    isSubagent: sourceIsSubagent || typeof payload.parent_thread_id === 'string',
  };
}

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private readonly codexHome = resolveCodexConfigRoot();
  private subagentsCleaned = false;

  /**
   * Scans ~/.codex/sessions and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    if (!since || !this.subagentsCleaned) {
      await this.removeIndexedSubagents();
      this.subagentsCleaned = true;
    }
    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.codexHome, 'sessions'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const existingSession = sessionsDb.getSessionById(parsed.sessionId);
      if (existingSession) {
        // If session name is untitled and we now have a name, update it
        if (existingSession.custom_name === 'Untitled Codex Session' && parsed.sessionName && parsed.sessionName !== 'Untitled Codex Session') {
          sessionsDb.updateSessionCustomName(parsed.sessionId, parsed.sessionName);
        }
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
   * Parses and upserts one Codex session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name');
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
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, parseCodexSessionMetadata);

    if (!parsed) {
      return null;
    }

    if (parsed.isSubagent) {
      // The transcript remains on disk and visible through its parent. Remove
      // only the derived sidebar index row that made it look like a peer chat.
      sessionsDb.deleteSessionById(parsed.sessionId);
      return null;
    }

    const existingSession = sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Codex Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Codex Session'),
      };
    }

    let sessionName = nameMap.get(parsed.sessionId);
    if (!sessionName) {
      sessionName = await this.extractLastAgentMessageFromEnd(filePath);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
    };
  }

  /** Cleans rows created by older versions even when the incremental scan cursor
   * no longer revisits their transcript files.
   */
  private async removeIndexedSubagents(): Promise<void> {
    for (const session of sessionsDb.getAllSessions()) {
      if (session.provider !== this.provider || !session.jsonl_path) continue;
      const metadata = await extractFirstValidJsonlData(
        session.jsonl_path,
        parseCodexSessionMetadata,
      );
      if (metadata?.isSubagent && metadata.sessionId === session.session_id) {
        sessionsDb.deleteSessionById(session.session_id);
      }
    }
  }

  private async extractLastAgentMessageFromEnd(filePath: string): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const payload = data.payload as Record<string, unknown> | undefined;
        const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
        const lastAgentMessage = typeof payload?.last_agent_message === 'string'
          ? payload.last_agent_message
          : undefined;

        if (eventType === 'event_msg' && payloadType === 'task_complete' && lastAgentMessage?.trim()) {
          return lastAgentMessage;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
