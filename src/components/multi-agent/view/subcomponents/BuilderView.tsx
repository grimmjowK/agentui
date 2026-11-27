/**
 * 建立器：直接複用聊天頁（ChatInterface），以 builder 模式運行（design D3）。
 * 建立器會話不導向 /session/:id，而是保存為該多 Agent 的 builderSession。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PROVIDER_IDS, isLLMProvider, type LLMProvider } from '../../../../../shared/providers';
import ChatInterface from '../../../chat/view/ChatInterface';
import type { ChatBuilderConfig } from '../../../chat/utils/builderContext';
import { useWebSocket } from '../../../../contexts/WebSocketContext';
import { useUiPreferences } from '../../../../hooks/useUiPreferences';
import type { Project, ProjectSession } from '../../../../types/app';
import { api } from '../../../../utils/api';
import { BUILDER_PROMPT_VERSION, buildBuilderPrompt, DEFINITION_LANGUAGE } from '../../constants/builderPrompts';
import { upsertMultiAgentLocal } from '../../hooks/useMultiAgents';
import { useProviderModels } from '../../hooks/useProviderModels';
import type { MultiAgent, MultiAgentDefinition, MultiAgentDetail } from '../../types/types';
import { readData } from '../../utils/fetchJson';

import DefinitionPreviewCard from './DefinitionPreviewCard';

type BuilderViewProps = {
  agent: MultiAgentDetail;
  /** 從已建立的多 Agent 點「用 AI 修改」進入：下一則訊息附上目前定義與最新格式說明 */
  editing?: boolean;
  /** 定義保存成功後回呼（頁面切換到流程圖／群聊） */
  onDefinitionSaved: (agent: MultiAgent) => void;
};

export default function BuilderView({ agent, editing = false, onDefinitionSaved }: BuilderViewProps) {
  const { t } = useTranslation('multiAgent');
  const { ws, sendMessage, latestMessage } = useWebSocket();
  const { preferences } = useUiPreferences();
  const models = useProviderModels();
  const [builderSession, setBuilderSession] = useState(agent.builderSession);
  const [inputRequest, setInputRequest] = useState<ChatBuilderConfig['inputRequest']>(null);
  // 進入建立器後，若既有會話收到的說明已過時，或是「用 AI 修改」，下一則訊息重新附上說明
  const [resendPrompt, setResendPrompt] = useState(
    () => Boolean(agent.builderSession) && (editing || (agent.builderSession?.promptVersion ?? 1) < BUILDER_PROMPT_VERSION),
  );
  const deliveredVersionRef = useRef<number | null>(null);

  const project = useMemo<Project | null>(() => (agent.projectId ? {
    projectId: agent.projectId,
    displayName: agent.name,
    fullPath: agent.workspacePath,
    path: agent.workspacePath,
  } : null), [agent.projectId, agent.name, agent.workspacePath]);

  const session = useMemo<ProjectSession | null>(() => (builderSession ? {
    id: builderSession.sessionId,
    __provider: builderSession.provider,
    __projectId: agent.projectId ?? undefined,
  } : null), [builderSession, agent.projectId]);

  const builder = useMemo<ChatBuilderConfig>(() => ({
    promptPrefix: buildBuilderPrompt(
      agent.kind,
      PROVIDER_IDS.flatMap((provider) => {
        const list = models[provider];
        return list?.length ? [{ provider, models: list.map((m) => m.value) }] : [];
      }),
      agent.definition,
    ),
    emptyTitle: t(`builder.emptyTitle.${agent.kind}`),
    emptyDescription: t(`builder.emptyHint.${agent.kind}`),
    inputRequest,
    resendPrompt,
    onPromptDelivered: () => {
      deliveredVersionRef.current = BUILDER_PROMPT_VERSION;
      setResendPrompt(false);
      if (builderSession) {
        const next = { ...builderSession, promptVersion: BUILDER_PROMPT_VERSION };
        setBuilderSession(next);
        void readData<MultiAgent>(api.multiAgent.update(agent.id, { builderSession: next }))
          .then((saved) => upsertMultiAgentLocal(saved))
          .catch((err) => console.warn('[multi-agent] Failed to update builderSession promptVersion:', err));
      }
    },
  }), [agent.kind, agent.definition, agent.id, models, t, inputRequest, resendPrompt, builderSession]);

  const saveDefinition = useCallback(async (definition: MultiAgentDefinition) => {
    const saved = await readData<MultiAgent>(api.multiAgent.saveDefinition(agent.id, definition));
    upsertMultiAgentLocal(saved);
    onDefinitionSaved(saved);
  }, [agent.id, onDefinitionSaved]);

  const codeBlockRenderers = useMemo(() => ({
    [DEFINITION_LANGUAGE]: (code: string) => (
      <DefinitionPreviewCard
        kind={agent.kind}
        code={code}
        models={models}
        isEditing={Boolean(agent.definition)}
        onConfirm={saveDefinition}
        onAskFix={(errors) => setInputRequest((previous) => ({
          text: t('builder.fixPrompt', { errors: errors.map((e) => `- ${e}`).join('\n') }),
          nonce: (previous?.nonce ?? 0) + 1,
        }))}
      />
    ),
  }), [agent.kind, agent.definition, models, saveDefinition, t]);

  // 新會話建立時記住 sessionId，不導向 /session/:id；直接採用實際發起該輪的 provider
  const handleNavigateToSession = useCallback((sessionId: string, options?: { provider?: LLMProvider }) => {
    if (builderSession?.sessionId === sessionId) return;
    const selected = localStorage.getItem('selected-provider');
    const provider: LLMProvider = options?.provider
      ?? builderSession?.provider
      ?? (isLLMProvider(selected) ? selected : 'claude');
    // 新會話的第一則訊息一定附了說明
    const next = { provider, sessionId, promptVersion: deliveredVersionRef.current ?? BUILDER_PROMPT_VERSION };
    setBuilderSession(next);
    void readData<MultiAgent>(api.multiAgent.update(agent.id, { builderSession: next }))
      .then((saved) => upsertMultiAgentLocal(saved))
      .catch((err) => console.warn('[multi-agent] Failed to persist builderSession:', err));
  }, [agent.id, builderSession]);

  if (!project) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('errors.loadFailed')}</div>;
  }

  return (
    <ChatInterface
      selectedProject={project}
      selectedSession={session}
      ws={ws}
      sendMessage={sendMessage}
      latestMessage={latestMessage}
      onNavigateToSession={handleNavigateToSession}
      autoExpandTools={preferences.autoExpandTools}
      showRawParameters={preferences.showRawParameters}
      showThinking={preferences.showThinking}
      autoScrollToBottom={preferences.autoScrollToBottom}
      sendByCtrlEnter={preferences.sendByCtrlEnter}
      builder={builder}
      codeBlockRenderers={codeBlockRenderers}
    />
  );
}
