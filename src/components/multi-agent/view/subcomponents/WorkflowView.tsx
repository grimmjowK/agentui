/**
 * 工作流頁面：流程圖 + 節點詳情抽屜 + 開始／停止（multi-agent-workflow spec）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, CircleDashed, History, Loader2, UserCheck, Play, ShieldQuestion, SkipForward, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { isApprovalNode, layerWorkflow } from '../../../../../shared/multiAgent';
import { getDefaultPermissionMode, PROVIDER_INFO, type LLMProvider, type PermissionMode } from '../../../../../shared/providers';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { cn } from '../../../../lib/utils';
import { api } from '../../../../utils/api';
import { upsertMultiAgentLocal } from '../../hooks/useMultiAgents';
import { modelLabel, useProviderModels } from '../../hooks/useProviderModels';
import { useWorkflowRun } from '../../hooks/useWorkflowRun';
import type { MultiAgent, NodeRunState, NodeRunStatus, WorkflowDef, WorkflowNode, WorkflowRun } from '../../types/types';
import { readData } from '../../utils/fetchJson';
import { Markdown } from '../../../chat/view/subcomponents/Markdown';

import ModelPicker from './ModelPicker';
import NodeToolApprovals from './NodeToolApprovals';
import WorkflowGraph from './WorkflowGraph';

const NODE_W = 220;
const NODE_H = 92;

const STATE_STYLE: Record<NodeRunState, { icon: typeof Check; className: string; bar: string }> = {
  pending: { icon: CircleDashed, className: 'text-muted-foreground', bar: 'bg-muted-foreground/30' },
  running: { icon: Loader2, className: 'text-primary animate-spin', bar: 'bg-primary' },
  waiting_approval: { icon: ShieldQuestion, className: 'text-amber-500', bar: 'bg-amber-500' },
  waiting_confirmation: { icon: UserCheck, className: 'text-amber-500 animate-pulse', bar: 'bg-amber-500' },
  succeeded: { icon: Check, className: 'text-emerald-500', bar: 'bg-emerald-500' },
  failed: { icon: X, className: 'text-destructive', bar: 'bg-destructive' },
  skipped: { icon: SkipForward, className: 'text-muted-foreground', bar: 'bg-muted-foreground/30' },
};

type WorkflowViewProps = {
  agent: MultiAgent;
  onAgentChange: (agent: MultiAgent) => void;
};

export default function WorkflowView({ agent, onAgentChange }: WorkflowViewProps) {
  const { t } = useTranslation('multiAgent');
  const models = useProviderModels();
  const { run: latestRun, isRunning, start, stop, confirm, error, clearError } = useWorkflowRun(agent.id);
  /** 查看歷史執行時的快照；null 表示看最近一次 */
  const [historyRun, setHistoryRun] = useState<WorkflowRun | null>(null);
  const run = historyRun ?? latestRun;
  const viewingHistory = Boolean(historyRun);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // 執行中或看歷史時以 run 快照顯示，否則用目前定義
  const def = ((isRunning || viewingHistory) && run ? run.definition : agent.definition) as WorkflowDef;
  const states = run?.nodeStates ?? {};
  const selected = def.nodes.find((n) => n.id === selectedId) ?? null;
  const nodeModelText = (node: WorkflowNode) => (isApprovalNode(node)
    ? t('workflow.approvalNode')
    : modelLabel(models, node.provider!, node.model!));

  // 執行到人工確認節點時自動打開它的詳情，方便直接核准
  const waitingId = viewingHistory ? null
    : Object.entries(states).find(([, s]) => s.state === 'waiting_confirmation' || s.state === 'waiting_approval')?.[0] ?? null;
  useEffect(() => { if (waitingId) setSelectedId(waitingId); }, [waitingId]);

  const saveNode = useCallback(async (next: WorkflowNode) => {
    const current = agent.definition as WorkflowDef;
    const definition: WorkflowDef = { nodes: current.nodes.map((n) => (n.id === next.id ? next : n)) };
    const saved = await readData<MultiAgent>(api.multiAgent.saveDefinition(agent.id, definition));
    upsertMultiAgentLocal(saved);
    onAgentChange(saved);
  }, [agent.definition, agent.id, onAgentChange]);

  const hasParallel = useMemo(() => (layerWorkflow(def) ?? []).some((layer) => layer.length > 1), [def]);

  const statusLabel = run ? t(`workflow.${run.status === 'stopping' ? 'running' : run.status}`) : t('workflow.idle');

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={cn('h-2 w-2 rounded-full', isRunning ? 'animate-pulse bg-primary'
              : run?.status === 'succeeded' ? 'bg-emerald-500'
                : run && run.status !== 'running' ? 'bg-destructive' : 'bg-muted-foreground/40')} />
            {statusLabel}
          </div>
          <div className="flex items-center gap-2">
          <RunHistory
            multiAgentId={agent.id}
            currentId={historyRun?.id ?? null}
            onSelect={(picked) => { setHistoryRun(picked); setSelectedId(null); }}
          />
          {isRunning ? (
            <button
              type="button"
              onClick={() => void stop()}
              disabled={run?.status === 'stopping'}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              <Square className="h-3 w-3 fill-current" />{t('workflow.stop')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { setHistoryRun(null); setConfirming(true); }}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Play className="h-3 w-3 fill-current" />{t('workflow.start')}
            </button>
          )}
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={clearError} aria-label="close"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <WorkflowGraph
          def={def}
          nodeWidth={NODE_W}
          nodeHeight={NODE_H}
          pannable
          className="min-h-0 flex-1 bg-[radial-gradient(circle,hsl(var(--border))_1px,transparent_1px)] [background-size:20px_20px]"
          activeEdge={(from, to) => states[from]?.state === 'succeeded' && ['running', 'waiting_approval', 'waiting_confirmation'].includes(states[to]?.state ?? '')}
          renderNode={(node) => (
            <NodeCard
              node={node}
              status={run ? states[node.id] : undefined}
              modelText={nodeModelText(node)}
              selected={node.id === selectedId}
              onClick={() => setSelectedId(node.id === selectedId ? null : node.id)}
            />
          )}
        />
      </div>

      {selected && (
        <NodeDetailPanel
          key={selected.id}
          node={selected}
          status={run ? states[selected.id] : undefined}
          upstream={states}
          def={def}
          readonly={isRunning || viewingHistory}
          canConfirm={!viewingHistory}
          onConfirm={(approved, note) => confirm(selected.id, approved, note)}
          models={models}
          onSave={saveNode}
          onClose={() => setSelectedId(null)}
        />
      )}

      {confirming && (
        <StartConfirm
          def={def}
          hasParallel={hasParallel}
          modelText={nodeModelText}
          onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); void start(); }}
        />
      )}
    </div>
  );
}

function NodeCard({ node, status, modelText, selected, onClick }: {
  node: WorkflowNode;
  status?: NodeRunStatus;
  modelText: string;
  selected: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation('multiAgent');
  const state = status?.state;
  const style = state ? STATE_STYLE[state] : null;
  const Icon = style?.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-full w-full flex-col rounded-xl border bg-card px-3 pb-2.5 pt-2.5 text-left shadow-sm transition-all hover:shadow-md',
        selected ? 'border-primary ring-2 ring-primary/20' : 'border-border/70 hover:border-border',
        state === 'failed' && !selected && 'border-destructive/40',
        state === 'succeeded' && !selected && 'border-emerald-500/40',
        state === 'waiting_confirmation' && !selected && 'border-amber-500/60',
        isApprovalNode(node) && 'border-dashed',
      )}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{node.title}</span>
        {Icon && <Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', style!.className)} aria-label={t(`workflow.nodeState.${state}`)} />}
      </div>
      <span className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
        {isApprovalNode(node)
          ? <UserCheck className="h-3 w-3 flex-shrink-0 text-amber-500" />
          : <SessionProviderLogo provider={node.provider!} className="h-3 w-3 flex-shrink-0" />}
        {modelText}
      </span>
      <div className="mt-auto">
        <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{state ? t(`workflow.nodeState.${state}`) : t('workflow.nodeState.pending')}</span>
          {status && state !== 'skipped' && <span>{Math.round(status.progress)}%</span>}
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-all duration-500', style?.bar ?? 'bg-muted-foreground/30')}
            style={{ width: `${status ? (state === 'skipped' ? 0 : status.progress) : 0}%` }}
          />
        </div>
      </div>
    </button>
  );
}

function NodeDetailPanel({ node, status, upstream, def, readonly, canConfirm, onConfirm, models, onSave, onClose }: {
  node: WorkflowNode;
  status?: NodeRunStatus;
  /** 人工確認時要審閱的上游輸出 */
  upstream: Record<string, NodeRunStatus>;
  def: WorkflowDef;
  readonly: boolean;
  canConfirm: boolean;
  onConfirm: (approved: boolean, note: string) => Promise<void>;
  models: ReturnType<typeof useProviderModels>;
  onSave: (node: WorkflowNode) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation('multiAgent');
  const [draft, setDraft] = useState(node);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setDraft(node), [node]);
  const dirty = draft.instruction !== node.instruction || draft.model !== node.model
    || draft.provider !== node.provider || draft.permissionMode !== node.permissionMode;
  const approval = isApprovalNode(node);
  const permissionMode = draft.permissionMode ?? (draft.provider ? getDefaultPermissionMode(draft.provider) : 'default');
  const waitingConfirmation = canConfirm && status?.state === 'waiting_confirmation';
  const viewingHistoryPanel = !canConfirm;
  const upstreamOutputs = node.dependsOn.map((id) => ({
    id,
    title: def.nodes.find((n) => n.id === id)?.title ?? id,
    output: upstream[id]?.output ?? '',
  }));
  const [note, setNote] = useState('');
  const [confirmingAction, setConfirmingAction] = useState(false);
  const decide = async (approved: boolean) => {
    setConfirmingAction(true);
    try { await onConfirm(approved, note); } finally { setConfirmingAction(false); }
  };
  const depTitles = node.dependsOn.map((id) => def.nodes.find((n) => n.id === id)?.title ?? id);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await onSave(draft);
      setMessage(t('workflow.node.saved'));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="flex w-full max-w-sm flex-shrink-0 flex-col border-l border-border/60 bg-background max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-20 max-md:shadow-xl">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{node.title}</span>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {readonly && !waitingConfirmation && <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">{t('workflow.node.readonly')}</p>}
        {status?.sessionId && !viewingHistoryPanel && <NodeToolApprovals sessionId={status.sessionId} />}
        {waitingConfirmation && (
          <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <UserCheck className="h-4 w-4 text-amber-500" />{t('workflow.approval.waiting')}
            </p>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{node.instruction}</p>
            {upstreamOutputs.map(({ id, title, output }) => (
              <details key={id} open={upstreamOutputs.length === 1} className="rounded-lg bg-background">
                <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-foreground">{title}</summary>
                <div className="max-h-72 overflow-auto px-3 pb-2">
                  <Markdown className="prose prose-sm max-w-none dark:prose-invert">{output || t('workflow.node.noOutput')}</Markdown>
                </div>
              </details>
            ))}
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={4}
              placeholder={t('workflow.approval.notePlaceholder')}
              className="w-full resize-y rounded-lg border border-border/70 bg-background px-3 py-2 text-sm leading-relaxed focus:border-primary/50 focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={confirmingAction}
                onClick={() => void decide(false)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent disabled:opacity-50"
              >
                {t('workflow.approval.reject')}
              </button>
              <button
                type="button"
                disabled={confirmingAction}
                onClick={() => void decide(true)}
                className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />{t('workflow.approval.approve')}
              </button>
            </div>
          </div>
        )}
        {depTitles.length > 0 && (
          <Field label={t('workflow.node.dependsOn')}>
            <div className="flex flex-wrap gap-1">
              {depTitles.map((title) => <span key={title} className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{title}</span>)}
            </div>
          </Field>
        )}
        {!approval && (<>
        <Field label={t('workflow.node.model')}>
          <ModelPicker
            provider={draft.provider!}
            model={draft.model!}
            models={models}
            disabled={readonly}
            onChange={(provider, model) => setDraft((d) => ({
              ...d,
              provider,
              model,
              // 換 provider 時權限模式可能不適用，回到預設
              permissionMode: provider === d.provider ? d.permissionMode : undefined,
            }))}
          />
        </Field>
        <Field label={t('workflow.node.permission')}>
          <PermissionSelect
            provider={draft.provider!}
            value={permissionMode}
            disabled={readonly}
            onChange={(mode) => setDraft((d) => ({ ...d, permissionMode: mode }))}
          />
        </Field>
        </>)}
        <Field label={approval ? t('workflow.approval.instruction') : t('workflow.node.instruction')}>
          <textarea
            value={draft.instruction}
            disabled={readonly}
            onChange={(event) => setDraft((d) => ({ ...d, instruction: event.target.value }))}
            rows={8}
            className="w-full resize-y rounded-lg border border-border/70 bg-background px-3 py-2 text-sm leading-relaxed focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/15 disabled:opacity-60"
          />
        </Field>
        {status && !waitingConfirmation && (
          <Field label={status.error ? t('workflow.node.error') : t('workflow.node.output')}>
            {status.error && <p className="mb-2 text-xs text-destructive">{status.error}</p>}
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-foreground">
              {status.output || t('workflow.node.noOutput')}
            </pre>
          </Field>
        )}
      </div>
      {!readonly && (
        <div className="flex items-center justify-end gap-3 border-t border-border/60 px-4 py-3">
          {message && <span className="text-xs text-muted-foreground">{message}</span>}
          <button
            type="button"
            disabled={!dirty || saving || !draft.instruction.trim()}
            onClick={() => void save()}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('workflow.node.save')}
          </button>
        </div>
      )}
    </aside>
  );
}

export function PermissionSelect({ provider, value, disabled, onChange }: {
  provider: LLMProvider;
  value: PermissionMode;
  disabled?: boolean;
  onChange: (mode: PermissionMode) => void;
}) {
  const { t } = useTranslation('multiAgent');
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as PermissionMode)}
      className="w-full rounded-lg border border-border/70 bg-background px-2.5 py-1.5 text-sm focus:border-primary/50 focus:outline-none disabled:opacity-60"
    >
      {PROVIDER_INFO[provider].permissionModes.map((mode) => (
        <option key={mode} value={mode}>{t(`permission.${mode}`)}</option>
      ))}
    </select>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function StartConfirm({ def, hasParallel, modelText, onCancel, onConfirm }: {
  def: WorkflowDef;
  hasParallel: boolean;
  modelText: (node: WorkflowNode) => string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('multiAgent');
  useEffect(() => {
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div role="dialog" aria-modal className="w-full max-w-sm rounded-2xl border border-border/60 bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-foreground">{t('workflow.confirmTitle')}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{t('workflow.confirmBody', { count: def.nodes.filter((n) => !isApprovalNode(n)).length })}</p>
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
          {def.nodes.map((node) => (
            <li key={node.id} className="flex items-center gap-2 text-xs">
              {isApprovalNode(node)
                ? <UserCheck className="h-3 w-3 text-amber-500" />
                : <SessionProviderLogo provider={node.provider!} className="h-3 w-3" />}
              <span className="min-w-0 flex-1 truncate text-foreground">{node.title}</span>
              <span className="text-muted-foreground">{modelText(node)}</span>
            </li>
          ))}
        </ul>
        {hasParallel && (
          <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            {t('workflow.parallelWarning')}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent">{t('list.cancel')}</button>
          <button type="button" autoFocus onClick={onConfirm} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            {t('workflow.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

function RunHistory({ multiAgentId, currentId, onSelect }: {
  multiAgentId: string;
  currentId: string | null;
  onSelect: (run: WorkflowRun | null) => void;
}) {
  const { t, i18n } = useTranslation('multiAgent');
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);

  useEffect(() => {
    if (!open) return;
    readData<WorkflowRun[]>(api.multiAgent.listRuns(multiAgentId)).then(setRuns).catch(() => setRuns([]));
  }, [open, multiAgentId]);

  const format = (iso: string) => new Date(iso).toLocaleString(i18n.language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn('flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-accent',
          currentId ? 'bg-accent text-foreground' : 'text-muted-foreground')}
      >
        <History className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t('workflow.history')}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-xl border border-border/60 bg-popover p-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          <button
            type="button"
            onClick={() => { onSelect(null); setOpen(false); }}
            className={cn('flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent', !currentId && 'font-medium text-foreground')}
          >
            {t('workflow.latest')}
          </button>
          {runs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => { onSelect(item); setOpen(false); }}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent', currentId === item.id && 'bg-accent/60')}
            >
              <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full',
                item.status === 'succeeded' ? 'bg-emerald-500' : item.status === 'running' || item.status === 'stopping' ? 'bg-primary' : 'bg-destructive')} />
              <span className="flex-1 text-foreground">{format(item.startedAt)}</span>
              <span className="text-muted-foreground">{t(`workflow.${item.status === 'stopping' ? 'running' : item.status}`)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
