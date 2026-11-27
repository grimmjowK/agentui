/**
 * Antigravity（ACP）的待審批池（ACP design D4）。
 * 只做五件事：新增、決定、逾時、依執行個體清除、依使用者列出。
 */
import { randomUUID } from 'node:crypto';

import type { PendingApprovalItem } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';

import { mapAgyTool } from './antigravity-tool-mapper.js';

export type AcpPermissionOption = { optionId: string; name?: string; kind?: string };
/** 回覆給 agy 的 `session/request_permission` 結果 */
export type AcpPermissionOutcome = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } };

type Pending = {
  requestId: string;
  userId: string | number;
  sessionId: string;
  instanceId: string;
  /** 前端看到的決定（allow / deny）→ ACP optionId */
  optionByDecision: Map<string, string>;
  message: AnyRecord;
  resolve: (outcome: AcpPermissionOutcome) => void;
  notify: (message: AnyRecord) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** ACP option kind → 前端決定名稱。allow_always 這類「永久放寬」選項刻意不提供。 */
function decisionOf(option: AcpPermissionOption): string | null {
  if (option.kind === 'allow_once') return 'allow';
  if (option.kind === 'reject_once' || option.kind === 'reject_always') return 'deny';
  return null;
}

export class AntigravityApprovals {
  private readonly pending = new Map<string, Pending>();

  timeoutMs(): number {
    const parsed = Number.parseInt(process.env.ANTIGRAVITY_APPROVAL_TIMEOUT_MS ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
  }

  /** 新增一筆待審批；回傳等待使用者決定的 Promise。 */
  add(options: {
    userId: string | number | null;
    sessionId: string;
    instanceId: string;
    toolCall: AnyRecord;
    options: AcpPermissionOption[];
    notify: (message: AnyRecord) => void;
  }): Promise<AcpPermissionOutcome> {
    // 沒有使用者身分就無人能審批，直接拒絕，不讓這一輪卡住
    const denyId = options.options.find((o) => decisionOf(o) === 'deny')?.optionId;
    if (options.userId === null || options.userId === undefined) {
      return Promise.resolve(denyId ? { outcome: { outcome: 'selected', optionId: denyId } } : { outcome: { outcome: 'cancelled' } });
    }

    const optionByDecision = new Map<string, string>();
    for (const option of options.options) {
      const decision = decisionOf(option);
      if (decision && !optionByDecision.has(decision)) optionByDecision.set(decision, option.optionId);
    }
    if (!optionByDecision.size) return Promise.resolve({ outcome: { outcome: 'cancelled' } });

    const requestId = randomUUID();
    const expiresAt = Date.now() + this.timeoutMs();
    const args = (options.toolCall.args ?? options.toolCall.rawInput ?? {}) as AnyRecord;
    const { toolName, toolInput } = mapAgyTool(String(options.toolCall.name ?? ''), args);
    const message: AnyRecord = {
      kind: 'permission_request',
      provider: 'antigravity',
      sessionId: options.sessionId,
      requestId,
      toolName,
      input: toolInput,
      receivedAt: new Date().toISOString(),
      context: { provider: 'antigravity', decisions: [...optionByDecision.keys()], expiresAt },
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(requestId, 'deny', 'expired'), expiresAt - Date.now());
      timer.unref?.();
      this.pending.set(requestId, {
        requestId,
        userId: options.userId as string | number,
        sessionId: options.sessionId,
        instanceId: options.instanceId,
        optionByDecision,
        message,
        resolve,
        notify: options.notify,
        timer,
      });
      options.notify(message);
    });
  }

  /** 使用者決定；呼叫者不是發起者或決定不在選項內時回傳 false。 */
  decide(requestId: string, userId: string | number | null, decision: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || userId === null || userId === undefined || String(entry.userId) !== String(userId)) return false;
    if (typeof decision !== 'string' || !entry.optionByDecision.has(decision)) return false;
    this.finish(requestId, decision, 'resolved');
    return true;
  }

  /** 執行個體結束（中斷、行程退出、這一輪結束）：未決項目回覆已取消。 */
  clearInstance(instanceId: string, reason = 'cancelled'): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.instanceId === instanceId) this.finish(entry.requestId, null, reason);
    }
  }

  hasPending(instanceId: string): boolean {
    return [...this.pending.values()].some((entry) => entry.instanceId === instanceId);
  }

  list(userId: string | number | null, sessionId?: string): PendingApprovalItem[] {
    if (userId === null || userId === undefined) return [];
    return [...this.pending.values()]
      .filter((entry) => String(entry.userId) === String(userId) && (!sessionId || entry.sessionId === sessionId))
      .map((entry) => ({
        requestId: entry.requestId,
        toolName: String(entry.message.toolName),
        input: entry.message.input,
        context: entry.message.context,
        sessionId: entry.sessionId,
        provider: 'antigravity' as const,
        receivedAt: String(entry.message.receivedAt),
      }));
  }

  private finish(requestId: string, decision: string | null, reason: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    const optionId = decision ? entry.optionByDecision.get(decision) : undefined;
    entry.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
    // 與 Codex 相同：決定後也送 permission_cancelled，讓所有分頁與全域池移除卡片
    entry.notify({ kind: 'permission_cancelled', provider: 'antigravity', sessionId: entry.sessionId, requestId, reason });
  }
}

export const antigravityApprovals = new AntigravityApprovals();
