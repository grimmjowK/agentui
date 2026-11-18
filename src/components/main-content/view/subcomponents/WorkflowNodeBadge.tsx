/**
 * 工作流節點會話的標記：「工作流節點：<標題>」＋返回流程圖（node-live-session D6）。
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { api } from '../../../../utils/api';

type WorkflowInfo = { multiAgentId: string; nodeTitle: string | null };

export default function WorkflowNodeBadge({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('multiAgent');
  const navigate = useNavigate();
  const [info, setInfo] = useState<WorkflowInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    api.getSessionInfo(sessionId)
      .then((response: Response) => (response.ok ? response.json() : null))
      .then((body: { data?: { workflow?: WorkflowInfo | null } } | null) => {
        if (!cancelled) setInfo(body?.data?.workflow ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId]);

  if (!info) return null;
  return (
    <button
      type="button"
      onClick={() => navigate(`/multi-agent/${encodeURIComponent(info.multiAgentId)}`)}
      title={t('session.back')}
      className="flex min-w-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/15"
    >
      <ArrowLeft className="h-3 w-3 flex-shrink-0" />
      <Workflow className="h-3 w-3 flex-shrink-0" />
      <span className="truncate">{t('session.badge')}{info.nodeTitle ? `: ${info.nodeTitle}` : ''}</span>
    </button>
  );
}
