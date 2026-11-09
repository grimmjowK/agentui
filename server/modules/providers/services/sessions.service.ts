import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { projectsDb, sessionMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionPinService } from '@/modules/providers/services/session-pin.service.js';
import { isSessionMessageLogEnabled } from '@/shared/session-message-log-flags.js';
import { reconcileSessionMessageLog } from '@/modules/providers/services/session-message-reconciler.service.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

type ProviderHistoryCacheEntry = {
  mtimeMs: number;
  result: FetchHistoryResult;
};

const providerHistoryCache = new Map<string, ProviderHistoryCacheEntry>();
// ponytail: 按插入順序淘汰的簡易 LRU，命中時重新插入；需要按記憶體大小淘汰再換實作
const PROVIDER_HISTORY_CACHE_MAX = 20;

function cacheProviderHistory(key: string, entry: ProviderHistoryCacheEntry): void {
  providerHistoryCache.delete(key);
  providerHistoryCache.set(key, entry);
  while (providerHistoryCache.size > PROVIDER_HISTORY_CACHE_MAX) {
    const oldest = providerHistoryCache.keys().next().value;
    if (oldest === undefined) break;
    providerHistoryCache.delete(oldest);
  }
}

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Fetches persisted history by session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database.
   */
  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset' | 'beforeSeq'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const provider = session.provider as LLMProvider;
    const providerSessions = providerRegistry.resolveProvider(provider).sessions;
    if (!isSessionMessageLogEnabled()) {
      return providerSessions.fetchHistory(sessionId, {
        limit: options.limit ?? null,
        offset: options.offset ?? 0,
        beforeSeq: options.beforeSeq,
        projectPath: session.project_path ?? '',
      });
    }

    // 往前翻頁（帶 beforeSeq）時日誌已在首屏對帳過，直接讀 DB，不再全量解析 provider 歷史
    if (options.beforeSeq !== undefined && options.beforeSeq !== null) {
      const page = sessionMessagesDb.list(sessionId, {
        beforeSeq: options.beforeSeq,
        limit: options.limit ?? null,
      });
      return {
        messages: page.messages,
        total: page.total,
        hasMore: page.hasMore,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
        nextBeforeSeq: page.nextBeforeSeq,
      };
    }

    const cacheKey = `${provider}:${sessionId}`;
    let history: FetchHistoryResult;
    if (session.jsonl_path) {
      try {
        const mtimeMs = fsSync.statSync(session.jsonl_path).mtimeMs;
        const cached = providerHistoryCache.get(cacheKey);
        if (cached?.mtimeMs === mtimeMs) {
          history = cached.result;
          cacheProviderHistory(cacheKey, cached);
        } else {
          history = await providerSessions.fetchHistory(sessionId, {
            limit: null,
            offset: 0,
            projectPath: session.project_path ?? '',
          });
          cacheProviderHistory(cacheKey, { mtimeMs, result: history });
        }
      } catch {
        history = await providerSessions.fetchHistory(sessionId, {
          limit: null,
          offset: 0,
          projectPath: session.project_path ?? '',
        });
      }
    } else {
      history = await providerSessions.fetchHistory(sessionId, {
        limit: null,
        offset: 0,
        projectPath: session.project_path ?? '',
      });
    }

    reconcileSessionMessageLog({
      sessionId,
      provider,
      history: history.messages,
    });
    const page = sessionMessagesDb.list(sessionId, {
      beforeSeq: options.beforeSeq ?? null,
      offset: options.beforeSeq === undefined || options.beforeSeq === null
        ? options.offset ?? 0
        : 0,
      limit: options.limit ?? null,
    });
    return {
      messages: page.messages,
      total: page.total,
      hasMore: page.hasMore,
      offset: options.offset ?? 0,
      limit: options.limit ?? null,
      nextBeforeSeq: page.nextBeforeSeq,
      tokenUsage: history.tokenUsage,
    };
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk && session.jsonl_path) {
      removedFromDisk = await removeFileIfExists(session.jsonl_path);
    }

    await sessionPinService.removePinnedTranscript(sessionId);

    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * 切换会话收藏状态。
   *
   * 收藏后会在文件夹内置顶，并把转录复制一份到备份目录，
   * 这样 CLI 的全局保留期清理掉原文件后仍然读得到历史。
   */
  async toggleSessionStar(sessionId: string): Promise<{ sessionId: string; isStarred: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const isStarred = !session.isStarred;
    sessionsDb.updateSessionIsStarred(sessionId, isStarred);

    if (isStarred) {
      await sessionPinService.syncPinnedTranscript(sessionId);
    } else {
      await sessionPinService.removePinnedTranscript(sessionId);
    }

    return { sessionId, isStarred };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  // 不檢查 sessions 列是否存在：新 session 在同步器建立該列之前就要寫入
  getSessionModel(sessionId: string): { model: string | null } {
    return { model: sessionsDb.getSessionModel(sessionId) };
  },

  setSessionModel(sessionId: string, model: string): { sessionId: string; model: string } {
    sessionsDb.setSessionModel(sessionId, model);
    return { sessionId, model };
  },

  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
};
