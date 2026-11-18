/**
 * 節點詳情中的工具審批：顯示該節點 session 的待審批請求，可直接允許／拒絕。
 * 回覆走與聊天頁相同的 WS 訊息（claude-permission-response / codex-permission-response）。
 */
import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { usePendingApprovals } from '../../../../contexts/PendingApprovalsContext';
import { useWebSocket } from '../../../../contexts/WebSocketContext';
import { Markdown } from '../../../chat/view/subcomponents/Markdown';

export default function NodeToolApprovals({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('multiAgent');
  const { pendingApprovals, setPendingApprovals } = usePendingApprovals();
  const { sendMessage } = useWebSocket();
  const requests = pendingApprovals.filter((request) => request.sessionId === sessionId);
  if (!requests.length) return null;

  const decide = (request: (typeof requests)[number], allow: boolean) => {
    const { requestId, provider } = request;
    const decisions = (request.context as { decisions?: string[] } | undefined)?.decisions;
    if (provider === 'codex') {
      sendMessage({ type: 'codex-permission-response', requestId, sessionId, decision: allow ? 'accept' : 'decline' });
    } else if (Array.isArray(decisions)) {
      sendMessage({ type: 'permission-decision', provider, requestId, sessionId, decision: allow ? 'allow' : 'deny' });
    } else {
      sendMessage({ type: 'claude-permission-response', requestId, allow });
    }
    setPendingApprovals((pool) => pool.filter((item) => item.requestId !== requestId));
  };

  return (
    <div className="space-y-2">
      {requests.map((request) => {
        const input = (request.input ?? {}) as Record<string, unknown>;
        const plan = request.toolName === 'ExitPlanMode' && typeof input.plan === 'string' ? input.plan : null;
        const summary = plan ? null : JSON.stringify(input, null, 2);
        return (
          <div key={request.requestId} className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              {plan ? t('workflow.tool.planTitle') : t('workflow.tool.title', { tool: request.toolName })}
            </p>
            {plan ? (
              <div className="max-h-64 overflow-auto rounded-lg bg-background px-3 py-2">
                <Markdown className="prose prose-sm max-w-none dark:prose-invert">{plan}</Markdown>
              </div>
            ) : (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background px-3 py-2 text-[11px] text-muted-foreground">{summary}</pre>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => decide(request, false)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent"
              >
                {t('workflow.tool.deny')}
              </button>
              <button
                type="button"
                onClick={() => decide(request, true)}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('workflow.tool.allow')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
