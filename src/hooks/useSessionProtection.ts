import { useCallback, useState } from 'react';

// 会话标记为"活跃"后超过这个时长仍无新动作，视为标记已失效。
// 防止 complete/error 事件丢失（ws 断线等）导致某个会话永久卡在"活跃"、
// 外部刷新（projects_updated → externalMessageUpdate）被永久抑制，必须刷新页面才能恢复。
const SESSION_ACTIVE_TTL_MS = 5 * 60 * 1000;

export function useSessionProtection() {
  // sessionId → 最后一次标记为活跃的时间戳，配合 isSessionActive 做惰性过期判定。
  const [activeSessions, setActiveSessions] = useState<Map<string, number>>(new Map());
  const [processingSessions, setProcessingSessions] = useState<Set<string>>(new Set());

  const markSessionAsActive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setActiveSessions((prev) => {
      const next = new Map(prev);
      next.set(sessionId, Date.now());
      return next;
    });
  }, []);

  const markSessionAsInactive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setActiveSessions((prev) => {
      if (!prev.has(sessionId)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  // 惰性过期判定，不用 setInterval：查询时才判断是否已超过 TTL，
  // 避免多一个需要在 unmount 时清理的定时器。
  const isSessionActive = useCallback((sessionId?: string | null): boolean => {
    if (!sessionId) {
      return false;
    }
    const markedAt = activeSessions.get(sessionId);
    if (markedAt === undefined) {
      return false;
    }
    return Date.now() - markedAt < SESSION_ACTIVE_TTL_MS;
  }, [activeSessions]);

  const markSessionAsProcessing = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => new Set([...prev, sessionId]));
  }, []);

  const markSessionAsNotProcessing = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  return {
    activeSessions,
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    isSessionActive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
  };
}
