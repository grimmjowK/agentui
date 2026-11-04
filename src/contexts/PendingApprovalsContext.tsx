import { createContext, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';

import type { PendingPermissionRequest } from '../components/chat/types/types';
import { applyApprovalEvent } from '../utils/pendingApprovals';

import { useWebSocket } from './WebSocketContext';

type PendingApprovalsContextValue = {
  /** 使用者所有會話的待審批項目。 */
  pendingApprovals: PendingPermissionRequest[];
  setPendingApprovals: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
};

const PendingApprovalsContext = createContext<PendingApprovalsContextValue | null>(null);

/**
 * 全域待審批池（design D16）：連線時拉取全量，之後依即時事件增減，切換會話或 provider 都不清空。
 */
export function PendingApprovalsProvider({ children }: { children: ReactNode }) {
  const { latestMessage, isConnected, sendMessage } = useWebSocket();
  const [pendingApprovals, setPendingApprovals] = useState<PendingPermissionRequest[]>([]);
  const lastMessageRef = useRef<unknown>(null);

  useEffect(() => {
    if (isConnected) sendMessage({ type: 'get-pending-permissions' });
  }, [isConnected, sendMessage]);

  useEffect(() => {
    if (!latestMessage || lastMessageRef.current === latestMessage) return;
    lastMessageRef.current = latestMessage;
    setPendingApprovals((pool) => applyApprovalEvent(pool, latestMessage));
  }, [latestMessage]);

  const value = useMemo(() => ({ pendingApprovals, setPendingApprovals }), [pendingApprovals]);
  return <PendingApprovalsContext.Provider value={value}>{children}</PendingApprovalsContext.Provider>;
}

export function usePendingApprovals(): PendingApprovalsContextValue {
  const context = useContext(PendingApprovalsContext);
  if (!context) throw new Error('usePendingApprovals must be used within a PendingApprovalsProvider');
  return context;
}
