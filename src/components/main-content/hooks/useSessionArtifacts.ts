import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

export type SessionArtifact = {
  id: string;
  title: string;
  fileName: string;
  updatedAt: string;
  content: string;
};

/**
 * 讀取會話產物（design D15）。目前會話的一輪對話完成（complete）時自動刷新，
 * 其他會話的事件不觸發。
 */
export function useSessionArtifacts(sessionId: string | null, enabled: boolean, latestMessage: unknown) {
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([]);

  const refresh = useCallback(async () => {
    if (!enabled || !sessionId) {
      setArtifacts([]);
      return;
    }
    try {
      const response = await authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/artifacts`);
      if (!response.ok) return;
      const body = await response.json();
      setArtifacts(body?.data?.artifacts ?? []);
    } catch {
      // 網路錯誤時保留上次的內容
    }
  }, [enabled, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const message = latestMessage as { kind?: string; sessionId?: string; actualSessionId?: string } | null;
    if (message?.kind !== 'complete') return;
    if (message.sessionId !== sessionId && message.actualSessionId !== sessionId) return;
    void refresh();
  }, [latestMessage, refresh, sessionId]);

  return artifacts;
}
