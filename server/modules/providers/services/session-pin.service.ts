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
 * 每个会话一个子目录，文件名沿用原始 basename —— Gemini 依赖 `.json` /
 * `.jsonl` 后缀分支解析，扁平命名会丢掉后缀信息。
 */
const PINNED_ROOT = path.join(os.homedir(), '.cloudcli', 'pinned');

/** sessionId 会拼进路径，挡掉 `..` / 分隔符等越权写入 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

function pinnedDirFor(sessionId: string): string | null {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
    return null;
  }

  return path.join(PINNED_ROOT, sessionId);
}

/** 返回备份目录里的唯一一份转录文件 */
async function findPinnedFile(sessionId: string): Promise<string | null> {
  const pinnedDir = pinnedDirFor(sessionId);
  if (!pinnedDir) {
    return null;
  }

  try {
    const [fileName] = await fsp.readdir(pinnedDir);
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
    const session = sessionsDb.getSessionById(sessionId);
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
    const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path ?? null;

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
