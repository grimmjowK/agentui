import { sessionMessagesDb } from '@/modules/database/index.js';
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

let cleanupTimer: NodeJS.Timeout | null = null;

export function startSessionMessageLogCleanup(): void {
  if (cleanupTimer) return;
  runSessionMessageLogCleanup();
  cleanupTimer = setInterval(() => {
    try {
      runSessionMessageLogCleanup();
    } catch (error) {
      console.warn('[session-message-log] cleanup failed', error);
    }
  }, DAY_MS);
  cleanupTimer.unref();
}

export function stopSessionMessageLogCleanup(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
