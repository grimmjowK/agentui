import { randomUUID } from 'node:crypto';

import type { RpcMessage } from './app-server.js';

type Pending = {
  userId: string | number;
  threadId: string;
  turnId: string;
  instanceId: string;
  request: RpcMessage;
  message: Record<string, any>;
  reply: (result: unknown) => void;
  notify: (message: Record<string, any>) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CodexApprovals {
  private pending = new Map<string, Pending>();

  add(options: Omit<Pending, 'message' | 'timer'> & { item?: unknown; timeoutMs?: number }) {
    for (const [id, pending] of this.pending) {
      if (pending.instanceId === options.instanceId && pending.threadId === options.threadId
        && pending.turnId === options.turnId && pending.request.id === options.request.id) return id;
    }
    const requestId = randomUUID();
    const expiresAt = Date.now() + (options.timeoutMs ?? 600000);
    const method = options.request.method!;
    const isPermissions = method === 'item/permissions/requestApproval';
    const advertised = options.request.params?.availableDecisions;
    // 仅支持简单枚举决定；对象型决定（acceptWithExecpolicyAmendment、applyNetworkPolicyAmendment，
    // 见 docs/codex-runtime-protocol.md 0.163.0 记录）需要额外 UI 展示策略修正内容，暂不支持而过滤掉。
    let decisions = isPermissions ? ['accept', 'decline']
      : Array.isArray(advertised) ? advertised.filter((d) => ['accept', 'acceptForSession', 'decline', 'cancel'].includes(d))
        : ['accept', 'decline', 'cancel'];
    // 过滤后为空（请求只提供了不支持的对象型决定）时，回退为仅拒绝，避免产出无可选项的审批卡片。
    if (decisions.length === 0) {
      console.warn(`Codex approval ${method} advertised only unsupported decisions; falling back to decline.`,
        { advertised });
      decisions = ['decline'];
    }
    const message = {
      kind: 'permission_request', provider: 'codex', sessionId: options.threadId,
      requestId, toolName: method, input: { ...options.request.params, item: options.item },
      context: { provider: 'codex', decisions, expiresAt, scope: isPermissions ? 'turn' : 'operation' },
    };
    const timer = setTimeout(() => {
      try { this.finish(requestId, 'decline', 'expired'); } catch { /* Runtime disconnected. */ }
    }, expiresAt - Date.now());
    timer.unref();
    this.pending.set(requestId, { ...options, message, timer });
    options.notify(message);
    return requestId;
  }

  decide(requestId: string, userId: string | number | null, threadId: string, decision: unknown) {
    const entry = this.pending.get(requestId);
    if (!entry || userId === null || String(entry.userId) !== String(userId) || entry.threadId !== threadId) return false;
    if (!entry.message.context.decisions.includes(decision)) return false;
    this.finish(requestId, String(decision), 'resolved');
    return true;
  }

  private finish(requestId: string, decision: string, reason: string) {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    if (decision === 'decline' && !entry.message.context.decisions.includes('decline')
      && entry.message.context.decisions.includes('cancel')) decision = 'cancel';
    try {
      entry.reply(entry.request.method === 'item/permissions/requestApproval'
        ? { permissions: decision === 'accept' ? entry.request.params?.permissions ?? {} : {}, scope: 'turn' }
        : { decision });
    } finally {
      entry.notify({ kind: 'permission_cancelled', requestId, reason, provider: 'codex', sessionId: entry.threadId });
    }
  }

  clear(instanceId: string) {
    for (const [id, entry] of this.pending) {
      if (entry.instanceId === instanceId) {
        try { this.finish(id, 'decline', 'cancelled'); } catch { /* Disconnected runtime. */ }
      }
    }
  }

  replay(userId: string | number | null, threadId: string, notify: Pending['notify']) {
    for (const entry of this.pending.values()) {
      if (userId !== null && String(entry.userId) === String(userId) && entry.threadId === threadId) {
        entry.notify = notify;
        notify(entry.message);
      }
    }
  }
}

export const codexApprovals = new CodexApprovals();
