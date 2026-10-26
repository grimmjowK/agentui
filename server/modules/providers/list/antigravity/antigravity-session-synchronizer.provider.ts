import fsSync from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';
import {
  findFilesRecursivelyCreatedAfter,
  normalizeProjectPath,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';

export type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

export function parseAntigravitySessionPath(filePath: string): string | null {
  const parts = filePath.split(path.sep);
  const brainIndex = parts.indexOf('brain');
  if (brainIndex !== -1 && parts.length > brainIndex + 1) {
    return parts[brainIndex + 1];
  }
  return null;
}

/** Native transcript steps omit cwd; the CLI stores it in its summary index. */
function readNativeWorkspace(filePath: string, sessionId: string): string | null {
  const parts = filePath.split(path.sep);
  const brainIndex = parts.lastIndexOf('brain');
  if (brainIndex < 0) return null;
  const databasePath = path.join(parts.slice(0, brainIndex).join(path.sep), 'conversation_summaries.db');
  if (!fsSync.existsSync(databasePath)) return null;
  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const row = database.prepare('SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?')
      .get(sessionId) as { workspace_uris: string } | undefined;
    const uris: unknown = row ? JSON.parse(row.workspace_uris) : null;
    if (!Array.isArray(uris)) return null;
    const uri = uris.find((value) => typeof value === 'string' && value.startsWith('file://'));
    return uri ? normalizeProjectPath(fileURLToPath(uri)) : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export class AntigravitySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'antigravity' as const;

  /**
   * Scans Antigravity transcript directories and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const home = os.homedir();
    const candidateDirs = [
      path.join(home, '.gemini', 'antigravity-cli', 'brain'),
      path.join(home, '.gemini', 'antigravity', 'brain'),
    ];
    if (process.env.ANTIGRAVITY_HOME) {
      candidateDirs.unshift(path.join(process.env.ANTIGRAVITY_HOME, 'brain'));
    }

    let count = 0;
    const seenSessionIds = new Set<string>();

    for (const brainDir of candidateDirs) {
      if (!fsSync.existsSync(brainDir)) continue;
      const files = await findFilesRecursivelyCreatedAfter(
        brainDir,
        '.jsonl',
        since ?? null,
      );

      for (const filePath of files) {
        if (!filePath.endsWith('transcript.jsonl')) {
          continue;
        }

        const sid = parseAntigravitySessionPath(filePath);
        if (sid && seenSessionIds.has(sid)) {
          continue;
        }

        const result = await this.synchronizeFile(filePath);
        if (result) {
          if (sid) seenSessionIds.add(sid);
          count += 1;
        }
      }
    }

    return count;
  }

  /**
   * Synchronizes a single Antigravity transcript file into sessionsDb.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    try {
      const timestamps = await readFileTimestamps(filePath);
      const parsed = await this.parseTranscriptFile(filePath);
      if (!parsed) {
        return null;
      }

      return sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath,
      );
    } catch (error) {
      console.warn(`Failed to synchronize Antigravity session file ${filePath}:`, error);
      return null;
    }
  }

  private async parseTranscriptFile(filePath: string): Promise<ParsedSession | null> {
    try {
      // Path pattern: .../brain/<conversation-id>/.system_generated/logs/transcript.jsonl
      // or .../brain/<conversation-id>/transcript.jsonl
      const parts = filePath.split(path.sep);
      const brainIndex = parts.indexOf('brain');
      let sessionId = '';
      if (brainIndex !== -1 && parts.length > brainIndex + 1) {
        sessionId = parts[brainIndex + 1];
      }

      if (!sessionId) {
        return null;
      }

      const content = await readFile(filePath, 'utf8');
      const lines = content.split('\n').filter((line) => line.trim().length > 0);
      if (lines.length === 0) {
        return null;
      }

      let sessionName: string | undefined;
      const existing = sessionsDb.getSessionById(sessionId);
      // Keep the workspace chosen by the app: native URIs may resolve symlinks
      // (e.g. /var -> /private/var), which would split one project into two.
      let projectPath = existing?.project_path || readNativeWorkspace(filePath, sessionId);

      // Read lines to extract first user prompt and project workspace if present
      for (const line of lines.slice(0, 50)) {
        try {
          const entry = JSON.parse(line) as AnyRecord;
          const rawContent = typeof entry.content === 'string' ? entry.content : '';

          if (!sessionName && (entry.type === 'USER_INPUT' || entry.role === 'user' || entry.source === 'USER_EXPLICIT')) {
            let userPrompt = rawContent;
            const requestMatch = rawContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (requestMatch) {
              userPrompt = requestMatch[1].trim();
            } else if (userPrompt.includes('<user_information>')) {
              // Strip metadata blocks if present
              userPrompt = userPrompt.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
            } else {
              userPrompt = userPrompt.replace(/<[^>]+>/g, ' ').trim();
            }

            if (userPrompt) {
              sessionName = normalizeSessionName(userPrompt, 'Untitled Antigravity Session');
            }
          }

          if (!projectPath && entry.workspacePath && typeof entry.workspacePath === 'string') {
            projectPath = normalizeProjectPath(entry.workspacePath);
          } else if (!projectPath && rawContent) {
            const workspaceMatch =
              rawContent.match(/Active Workspaces:\s*\n-\s*([^\n\r]+)/) ||
              rawContent.match(/Command Working Directory:\s*([^\n\r]+)/);
            if (workspaceMatch && workspaceMatch[1]) {
              projectPath = normalizeProjectPath(workspaceMatch[1].trim());
            }
          }

          if (!projectPath && Array.isArray(entry.tool_calls)) {
            for (const toolCall of entry.tool_calls) {
              const tc = toolCall as AnyRecord;
              const args = tc.args as AnyRecord | undefined;
              let cwdVal = args?.Cwd || args?.cwd;
              if (typeof cwdVal === 'string') {
                cwdVal = cwdVal.replace(/^["']|["']$/g, '');
                if (cwdVal) {
                  projectPath = normalizeProjectPath(cwdVal);
                  break;
                }
              }
            }
          }
        } catch {
          // Ignore parse errors on individual lines
        }
      }

      // Unknown workspaces must not be attached to the server startup directory.
      if (!projectPath) return null;

      return {
        sessionId,
        projectPath,
        sessionName: existing?.custom_name || sessionName || `Session ${sessionId.slice(0, 8)}`,
      };
    } catch {
      return null;
    }
  }
}
