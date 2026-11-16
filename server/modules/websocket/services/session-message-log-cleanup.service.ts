import fsp from 'node:fs/promises';
import path from 'node:path';

import { sessionMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { sessionPinService } from '@/modules/providers/index.js';
import { isSessionLogActive } from '@/modules/websocket/services/logging-writer.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

export type SessionMessageLogCleanupResult = {
  deletedSessionIds: string[];
  remainingBytes: number;
};

function readNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function runSessionMessageLogCleanup(options: {
  now?: number;
  retentionDays?: number;
  maxBytes?: number;
} = {}): SessionMessageLogCleanupResult {
  const currentTime = options.now ?? Date.now();
  const retentionDays = options.retentionDays
    ?? readNonNegativeNumber(process.env.SESSION_LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const maxBytes = options.maxBytes
    ?? readNonNegativeNumber(process.env.SESSION_LOG_MAX_BYTES, DEFAULT_MAX_BYTES);
  const sizes = sessionMessagesDb.listSizes().filter((entry) => !isSessionLogActive(entry.sessionId));
  const deletedSessionIds: string[] = [];

  if (retentionDays > 0) {
    const cutoff = currentTime - retentionDays * DAY_MS;
    for (const entry of sizes) {
      if (!entry.starred && entry.updatedAt < cutoff) {
        sessionMessagesDb.deleteBySession(entry.sessionId);
        deletedSessionIds.push(entry.sessionId);
      }
    }
  }

  let remaining = sessionMessagesDb.listSizes()
    .filter((entry) => !isSessionLogActive(entry.sessionId));
  let remainingBytes = remaining.reduce((total, entry) => total + entry.bytes, 0);
  if (maxBytes > 0 && remainingBytes > maxBytes) {
    const target = Math.floor(maxBytes * 0.9);
    for (const entry of remaining) {
      if (remainingBytes <= target) break;
      if (entry.starred) continue;
      sessionMessagesDb.deleteBySession(entry.sessionId);
      deletedSessionIds.push(entry.sessionId);
      remainingBytes -= entry.bytes;
    }
  }

  remaining = sessionMessagesDb.listSizes()
    .filter((entry) => !isSessionLogActive(entry.sessionId));
  remainingBytes = remaining.reduce((total, entry) => total + entry.bytes, 0);
  return { deletedSessionIds, remainingBytes };
}

/** 刚建的会话可能还没写入 jsonl_path 或日志，给一天缓冲 */
const PRUNE_GRACE_MS = DAY_MS;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * 只有「文件确定不存在、但所在目录还在」才算转录已被 CLI 清掉。
 * CLI 清理只删文件、保留目录；整个目录读不到（volume 未挂载、HOME 变更）或权限/IO 错误时，
 * 可能只是暂时读不到，一律不算消失，避免启动时整批误删。
 */
async function isTranscriptGone(transcriptPath: string): Promise<boolean> {
  try {
    await fsp.stat(transcriptPath);
    return false;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return false;
  }
  try {
    return (await fsp.stat(path.dirname(transcriptPath))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 把已经读不到任何历史的会话从列表里删掉：provider 转录被 CLI 过期清理
 * （Claude cleanupPeriodDays / Codex 删除）、没有收藏备份、聊天日志也已清空。
 * 收藏与执行中的会话不动。
 */
export async function pruneExpiredSessions(options: { now?: number } = {}): Promise<string[]> {
  const cutoff = (options.now ?? Date.now()) - PRUNE_GRACE_MS;
  const deleted: string[] = [];
  for (const row of sessionsDb.listUnloggedUnstarredSessions()) {
    if (isSessionLogActive(row.session_id)) continue;
    const touchedAt = Date.parse(row.updated_at ?? row.created_at);
    if (!(touchedAt < cutoff)) continue;
    if (!row.jsonl_path || !(await isTranscriptGone(row.jsonl_path))) continue;
    if (await sessionPinService.resolveTranscriptPath(row.session_id)) continue;
    if (sessionsDb.deleteSessionById(row.session_id)) deleted.push(row.session_id);
  }
  if (deleted.length > 0) {
    console.log(`[session-cleanup] pruned ${deleted.length} sessions without history: ${deleted.join(', ')}`);
  }
  return deleted;
}

function runAllCleanup(): void {
  try {
    runSessionMessageLogCleanup();
  } catch (error) {
    console.warn('[session-message-log] cleanup failed', error);
  }
  pruneExpiredSessions().catch((error) => {
    console.warn('[session-cleanup] prune failed', error);
  });
}

let cleanupTimer: NodeJS.Timeout | null = null;

export function startSessionMessageLogCleanup(): void {
  if (cleanupTimer) return;
  runAllCleanup();
  cleanupTimer = setInterval(runAllCleanup, DAY_MS);
  cleanupTimer.unref();
}

export function stopSessionMessageLogCleanup(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
