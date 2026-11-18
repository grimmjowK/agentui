/**
 * /multi-agent/:id：依類型與定義是否為空分派到建立器／流程圖／群聊（design D8）。
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, MessagesSquare, Sparkles, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import MobileMenuButton from '../../main-content/view/subcomponents/MobileMenuButton';
import { api } from '../../../utils/api';
import type { MultiAgent, MultiAgentDetail } from '../types/types';
import { readData } from '../utils/fetchJson';

import BuilderView from './subcomponents/BuilderView';
import ChatroomView from './subcomponents/ChatroomView';
import WorkflowView from './subcomponents/WorkflowView';
import WorkspaceButton from './subcomponents/WorkspaceButton';

type MultiAgentPageProps = {
  multiAgentId: string;
  isMobile: boolean;
  onMenuClick: () => void;
};

export default function MultiAgentPage({ multiAgentId, isMobile, onMenuClick }: MultiAgentPageProps) {
  const { t } = useTranslation('multiAgent');
  const [agent, setAgent] = useState<MultiAgentDetail | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  /** 已建立後點「用 AI 修改」回到建立器 */
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    setEditing(false);
    readData<MultiAgentDetail>(api.multiAgent.get(multiAgentId))
      .then((data) => { if (alive) { setAgent(data); setStatus('ready'); } })
      .catch(() => { if (alive) setStatus('missing'); });
    return () => { alive = false; };
  }, [multiAgentId]);

  const handleAgentChange = useCallback((next: MultiAgent) => {
    setAgent((current) => (current ? { ...current, ...next } : current));
  }, []);

  const handleDefinitionSaved = useCallback((next: MultiAgent) => {
    handleAgentChange(next);
    setEditing(false);
  }, [handleAgentChange]);

  const showBuilder = agent && (!agent.definition || editing);
  const KindIcon = agent?.kind === 'workflow' ? Workflow : MessagesSquare;

  return (
    <div className="flex h-full flex-col">
      <div className="pwa-header-safe flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-2 sm:px-4">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
        {agent && (
          <>
            <span className={agent.kind === 'workflow'
              ? 'flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400'
              : 'flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400'}>
              <KindIcon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-foreground">{agent.name}</h2>
              <p className="truncate text-[11px] text-muted-foreground">
                {t(`kind.${agent.kind}`)}
                {!agent.definition && ` · ${t('page.draft')}`}
              </p>
            </div>
            <WorkspaceButton agent={agent} onChange={handleAgentChange} />
            {agent.definition && (editing ? (
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" />{t('page.backToCanvas')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Sparkles className="h-3.5 w-3.5" />{t('page.editWithAi')}
              </button>
            ))}
          </>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {status === 'loading' && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('page.loading')}</div>
        )}
        {status === 'missing' && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('page.notFound')}</div>
        )}
        {status === 'ready' && agent && (
          showBuilder ? (
            <BuilderView key={`${agent.id}:builder`} agent={agent} editing={editing} onDefinitionSaved={handleDefinitionSaved} />
          ) : agent.kind === 'workflow' ? (
            <WorkflowView key={agent.id} agent={agent} onAgentChange={handleAgentChange} />
          ) : (
            <ChatroomView key={agent.id} agent={agent} isMobile={isMobile} onAgentChange={handleAgentChange} />
          )
        )}
      </div>
    </div>
  );
}
