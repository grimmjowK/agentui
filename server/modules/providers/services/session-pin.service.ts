import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';

/**
 * 收藏会话的转录备份目录。
 *
 * CLI 自己的 `cleanupPeriodDays` 只能全局设置，没有 session 粒度的豁免，
 * 所以“收藏不过期”只能靠我们自己留一份副本：收藏时复制，文件更新时刷新，
 * 原文件被 CLI 清掉后读备份。
 *
 * 每个会话一个子目录，文件名沿用原始 basename —— 部分 provider 依赖 `.json` /
 * `.jsonl` 后缀分支解析，扁平命名会丢掉后缀信息。
 */
const PINNED_ROOT = path.join(os.homedir(), '.cloudcli', 'pinned');

/**
 * Antigravity 在主转录旁另存未截断的完整版；备份时一并复制，读取端（preferFullTranscript）
 * 会在同目录找到它。它不是主转录，findPinnedFile 不能返回它。
 */
const COMPANION_FILES = ['transcript_full.jsonl'];

/** sessionId 会拼进路径，挡掉 `..` / 分隔符等越权写入 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

function pinnedDirFor(sessionId: string): string | null {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
    return null;
  }

  return path.join(PINNED_ROOT, sessionId);
}

/** 啟動期間 sessions 表可能尚未建立；其他 DB 錯誤仍要留下可診斷訊息。 */
function isDatabaseNotReadyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (?:table:\s*sessions|column:\s*name_is_custom)(?:\s|$)/i.test(message);
}

function getSessionForPinning(sessionId: string, operation: string) {
  try {
    return sessionsDb.getSessionById(sessionId);
  } catch (error) {
    if (isDatabaseNotReadyError(error)) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to ${operation} pinned session ${sessionId}`, { error: message });
    return null;
  }
}

/** 返回备份目录里的唯一一份转录文件 */
async function findPinnedFile(sessionId: string): Promise<string | null> {
  const pinnedDir = pinnedDirFor(sessionId);
  if (!pinnedDir) {
    return null;
  }

  try {
    const fileName = (await fsp.readdir(pinnedDir)).find((name) => !COMPANION_FILES.includes(name));
    return fileName ? path.join(pinnedDir, fileName) : null;
  } catch {
    return null;
  }
}

export const sessionPinService = {
  /**
   * 把收藏会话的转录复制一份到备份目录；未收藏或没有转录文件则跳过。
   */
  async syncPinnedTranscript(sessionId: string): Promise<void> {
    const session = getSessionForPinning(sessionId, 'read');
    if (!session?.isStarred || !session.jsonl_path) {
      return;
    }

    const pinnedDir = pinnedDirFor(sessionId);
    if (!pinnedDir) {
      return;
    }

    try {
      await fsp.mkdir(pinnedDir, { recursive: true });
      await fsp.copyFile(session.jsonl_path, path.join(pinnedDir, path.basename(session.jsonl_path)));
      for (const name of COMPANION_FILES) {
        const companion = path.join(path.dirname(session.jsonl_path), name);
        await fsp.copyFile(companion, path.join(pinnedDir, name)).catch(() => {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to refresh pinned transcript for session ${sessionId}`, { error: message });
    }
  },

  /**
   * 取消收藏 / 删除会话 / 硬删除项目时清掉备份。
   */
  async removePinnedTranscript(sessionId: string): Promise<void> {
    const pinnedDir = pinnedDirFor(sessionId);
    if (!pinnedDir) {
      return;
    }

    await fsp.rm(pinnedDir, { recursive: true, force: true });
  },

  /**
   * 解析会话转录的可读路径：原文件还在就用原文件，被 CLI 清掉则回退到备份。
   */
  async resolveTranscriptPath(sessionId: string): Promise<string | null> {
    const jsonlPath = getSessionForPinning(sessionId, 'read')?.jsonl_path ?? null;

    if (jsonlPath) {
      try {
        await fsp.access(jsonlPath);
        return jsonlPath;
      } catch {
        // 原文件已不在，继续找备份
      }
    }

    return findPinnedFile(sessionId);
  },
};
