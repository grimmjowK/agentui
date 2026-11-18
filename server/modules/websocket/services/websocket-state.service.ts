import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();

/** 聊天連線對應的使用者，供只推給擁有者的事件（多 Agent）使用。 */
const clientUsers = new WeakMap<RealtimeClientConnection, string>();

export function setClientUser(client: RealtimeClientConnection, userId: string | number | null): void {
  if (userId !== null) clientUsers.set(client, String(userId));
}

/** 推送給該使用者所有已開啟的聊天連線。 */
export function sendToUser(userId: string | number, data: unknown): void {
  const payload = JSON.stringify(data);
  for (const client of connectedClients) {
    if (client.readyState === WS_OPEN_STATE && clientUsers.get(client) === String(userId)) {
      client.send(payload);
    }
  }
}
