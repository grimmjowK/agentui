import type { PendingPermissionRequest } from '../components/chat/types/types';

type ApprovalEvent = {
  type?: string;
  kind?: string;
  sessionId?: string | null;
  actualSessionId?: string | null;
  newSessionId?: string | null;
  requestId?: string;
  provider?: string;
  toolName?: string;
  input?: unknown;
  context?: unknown;
  receivedAt?: string;
  data?: PendingPermissionRequest[];
};

const sameSession = (request: PendingPermissionRequest, sessionId: string | null | undefined) =>
  (request.sessionId ?? null) === (sessionId ?? null);

/**
 * 全域待審批池的狀態轉移（design D16）。與 UI 狀態無關：不論事件屬於哪個會話都更新池，
 * 畫面上只渲染目前會話的項目。回傳原陣列表示沒有變化。
 */
export function applyApprovalEvent(pool: PendingPermissionRequest[], event: ApprovalEvent): PendingPermissionRequest[] {
  if (event.type === 'pending-permissions-response') {
    const incoming = (event.data ?? []).map((item) => ({ ...item, receivedAt: item.receivedAt ? new Date(item.receivedAt) : new Date() }));
    // 帶 sessionId 只替換該會話；不帶是全量快照
    return event.sessionId
      ? [...pool.filter((request) => request.sessionId !== event.sessionId), ...incoming]
      : incoming;
  }

  switch (event.kind) {
    case 'permission_request':
      if (!event.requestId || pool.some((request) => request.requestId === event.requestId)) return pool;
      return [...pool, {
        requestId: event.requestId,
        provider: event.provider,
        toolName: event.toolName || 'UnknownTool',
        input: event.input,
        context: event.context,
        sessionId: event.sessionId ?? null,
        receivedAt: new Date(),
      }];

    case 'permission_cancelled':
      return event.requestId ? pool.filter((request) => request.requestId !== event.requestId) : pool;

    case 'complete':
    case 'error': {
      const ended = [event.sessionId, event.actualSessionId].filter((id) => id !== undefined);
      if (ended.length === 0) ended.push(null);
      const next = pool.filter((request) => !ended.some((id) => sameSession(request, id)));
      return next.length === pool.length ? pool : next;
    }

    case 'session_created': {
      // 新會話在取得 id 之前發出的請求沒有 sessionId，補上
      const newSessionId = event.newSessionId;
      if (!newSessionId || !pool.some((request) => !request.sessionId)) return pool;
      return pool.map((request) => (request.sessionId ? request : { ...request, sessionId: newSessionId }));
    }

    default:
      return pool;
  }
}

/**
 * 事件是否屬於目前畫面上的會話。沒有 sessionId 的事件視為目前會話的（新會話尚未取得 id）。
 */
export function isEventForSession(eventSessionId: string | null | undefined, viewSessionIds: Array<string | null | undefined>): boolean {
  if (!eventSessionId) return true;
  return viewSessionIds.some((id) => Boolean(id) && id === eventSessionId);
}
