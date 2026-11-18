/**
 * 建立器聊天中 multi-agent-json 區塊的預覽卡片（multi-agent-builder spec）。
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Check, MessagesSquare, Sparkles, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { validateDefinition, validateModels } from '../../../../../shared/multiAgent';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { modelLabel, type ModelsByProvider } from '../../hooks/useProviderModels';
import type { ChatroomDef, MultiAgentDefinition, MultiAgentKind, WorkflowDef } from '../../types/types';
import { initialOf, memberColorClass } from '../../utils/memberColor';

import WorkflowGraph from './WorkflowGraph';

type DefinitionPreviewCardProps = {
  kind: MultiAgentKind;
  code: string;
  models: ModelsByProvider;
  /** 已建立後顯示「應用修改」 */
  isEditing: boolean;
  onConfirm: (definition: MultiAgentDefinition) => Promise<void>;
  onAskFix: (errors: string[]) => void;
};

export default function DefinitionPreviewCard({ kind, code, models, isEditing, onConfirm, onAskFix }: DefinitionPreviewCardProps) {
  const { t } = useTranslation('multiAgent');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { definition, errors } = useMemo(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(code);
    } catch (error) {
      return { definition: null, errors: [`JSON: ${(error as Error).message}`] };
    }
    const structural = validateDefinition(kind, parsed);
    if (structural.length) return { definition: null, errors: structural };
    const modelLists = Object.fromEntries(
      Object.entries(models).map(([provider, list]) => [provider, list?.map((m) => m.value) ?? []]),
    );
    // 模型清單尚未載入時不擋，保存時後端會再驗證
    const modelErrors = Object.keys(models).length
      ? validateModels(kind, parsed as MultiAgentDefinition, modelLists)
      : [];
    return { definition: parsed as MultiAgentDefinition, errors: modelErrors };
  }, [code, kind, models]);

  const allErrors = saveError ? [...errors, saveError] : errors;
  const Icon = kind === 'workflow' ? Workflow : MessagesSquare;

  const confirm = async () => {
    if (!definition || errors.length) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onConfirm(definition);
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="not-prose my-3 overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-sm font-medium text-foreground">{t('builder.preview')}</span>
        {definition && (
          <span className="text-xs text-muted-foreground">
            {kind === 'workflow'
              ? t('builder.nodes', { count: (definition as WorkflowDef).nodes.length })
              : t('builder.members', { count: (definition as ChatroomDef).members.length })}
          </span>
        )}
      </div>

      {definition && kind === 'workflow' && (
        <WorkflowGraph
          def={definition as WorkflowDef}
          nodeWidth={150}
          nodeHeight={52}
          gapX={36}
          gapY={12}
          padding={14}
          className="max-h-72 bg-muted/20"
          renderNode={(node) => (
            <div className="flex h-full flex-col justify-center rounded-lg border border-border/70 bg-background px-2.5 shadow-sm">
              <span className="truncate text-xs font-medium text-foreground">{node.title}</span>
              <span className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                <SessionProviderLogo provider={node.provider} className="h-2.5 w-2.5 flex-shrink-0" />
                {modelLabel(models, node.provider, node.model)}
              </span>
            </div>
          )}
        />
      )}

      {definition && kind === 'chatroom' && (
        <div className="space-y-1.5 bg-muted/20 p-3">
          {(definition as ChatroomDef).members.map((member) => (
            <div key={member.id} className="flex items-start gap-2.5 rounded-lg bg-background px-2.5 py-2">
              <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold ${memberColorClass(member.id)}`}>
                {initialOf(member.name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-foreground">{member.name}</span>
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <SessionProviderLogo provider={member.provider} className="h-2.5 w-2.5" />
                    {modelLabel(models, member.provider, member.model)}
                  </span>
                </div>
                {member.persona && <p className="line-clamp-2 text-xs text-muted-foreground">{member.persona}</p>}
              </div>
            </div>
          ))}
          {(definition as ChatroomDef).rules.text && (
            <p className="px-1 pt-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{t('chatroom.rules')}：</span>
              {(definition as ChatroomDef).rules.text}
            </p>
          )}
        </div>
      )}

      {allErrors.length > 0 && (
        <div className="space-y-1 border-t border-border/60 bg-destructive/5 px-3.5 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t('builder.invalid')}
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {allErrors.slice(0, 6).map((error) => <li key={error}>{error}</li>)}
          </ul>
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-border/60 px-3.5 py-2.5">
        {allErrors.length > 0 && (
          <button
            type="button"
            onClick={() => onAskFix(allErrors)}
            className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t('builder.fixWithAi')}
          </button>
        )}
        <button
          type="button"
          disabled={!definition || errors.length > 0 || saving}
          onClick={() => void confirm()}
          className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          {saving ? t('builder.saving') : isEditing ? t('builder.apply') : t('builder.create')}
        </button>
      </div>
    </div>
  );
}
