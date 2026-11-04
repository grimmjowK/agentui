import { useCallback, useEffect, useRef, useState } from 'react';

import { api, authenticatedFetch } from '../../../utils/api';
import {
  ANTIGRAVITY_MODELS,
  CLAUDE_MODELS,
  CODEX_MODELS,
  CURSOR_MODELS,
} from '../../../../shared/modelConstants';
import { PROVIDER_IDS, PROVIDER_INFO, getDefaultPermissionMode } from '../../../../shared/providers';
import { usePendingApprovals } from '../../../contexts/PendingApprovalsContext';
import type { PermissionMode } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';

const MODEL_DEFAULTS: Record<LLMProvider, string> = {
  claude: CLAUDE_MODELS.DEFAULT,
  cursor: CURSOR_MODELS.DEFAULT,
  codex: CODEX_MODELS.DEFAULT,
  antigravity: ANTIGRAVITY_MODELS.DEFAULT,
};

// 全域預設模型：新 session 使用，也是無記錄的存量 session 的回退值
const getDefaultModel = (provider: LLMProvider): string =>
  localStorage.getItem(`${provider}-model`) || MODEL_DEFAULTS[provider];

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
}

export function useChatProviderState({ selectedSession }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => (
    getDefaultPermissionMode((localStorage.getItem('selected-provider') as LLMProvider) || 'claude')
  ));
  // 全域待審批池（design D16）：切換 provider 或會話都不清空，畫面只渲染目前會話的項目
  const { pendingApprovals: pendingPermissionRequests, setPendingApprovals: setPendingPermissionRequests } = usePendingApprovals();
  const [provider, setProvider] = useState<LLMProvider>(() => {
    return (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
  });
  const [modelByProvider, setModelByProvider] = useState<Record<LLMProvider, string>>(
    () => Object.fromEntries(PROVIDER_IDS.map((id) => [id, getDefaultModel(id)])) as Record<LLMProvider, string>,
  );
  const setModelFor = useCallback((target: LLMProvider, model: string | ((current: string) => string)) => {
    setModelByProvider((previous) => ({
      ...previous,
      [target]: typeof model === 'function' ? model(previous[target]) : model,
    }));
  }, []);


  // 切換 session（或回到新 session 畫面）時還原該 session 的模型
  useEffect(() => {
    const sessionId = selectedSession?.id;
    // provider 尚未切到該 session 的 provider 時先跳過，等下一輪 effect
    if (selectedSession?.__provider && selectedSession.__provider !== provider) {
      return;
    }
    const setModel = (model: string) => setModelFor(provider, model);
    if (!sessionId) {
      setModel(getDefaultModel(provider));
      return;
    }

    let cancelled = false;
    api.getSessionModel(sessionId)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((payload) => {
        if (!cancelled) setModel(payload?.data?.model || getDefaultModel(provider));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSession?.id, selectedSession?.__provider, provider, setModelFor]);

  useEffect(() => {
    if (!selectedSession?.id) {
      setPermissionMode(getDefaultPermissionMode(provider));
      return;
    }

    const savedMode = localStorage.getItem(`permissionMode-${selectedSession.id}`) as PermissionMode | null;
    const validModes = PROVIDER_INFO[provider].permissionModes;
    setPermissionMode(savedMode && validModes.includes(savedMode) ? savedMode : getDefaultPermissionMode(provider));
  }, [selectedSession?.id, provider]);

  useEffect(() => {
    const onChange = (event: Event) => {
      if (provider !== 'antigravity' || selectedSession?.id) return;
      const nextMode = (event as CustomEvent<boolean>).detail ? 'bypassPermissions' : 'default';
      setPermissionMode(nextMode);
    };
    window.addEventListener('antigravity-permissions-change', onChange);
    return () => window.removeEventListener('antigravity-permissions-change', onChange);
  }, [provider, selectedSession?.id]);

  useEffect(() => {
    if (!selectedSession?.__provider || selectedSession.__provider === provider) {
      return;
    }

    setProvider(selectedSession.__provider);
    localStorage.setItem('selected-provider', selectedSession.__provider);
  }, [provider, selectedSession]);

  useEffect(() => {
    if (provider !== 'cursor') {
      return;
    }

    authenticatedFetch('/api/cursor/config')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.config?.model?.modelId) {
          return;
        }

        const modelId = data.config.model.modelId as string;
        if (!localStorage.getItem('cursor-model')) {
          setModelFor('cursor', modelId);
        }
      })
      .catch((error) => {
        console.error('Error loading Cursor config:', error);
      });
  }, [provider, setModelFor]);

  useEffect(() => {
    if (provider !== 'codex' || (selectedSession?.__provider && selectedSession.__provider !== provider)) {
      return;
    }

    api.providerModels('codex')
      .then((response) => response.json())
      .then((payload) => {
        const models: Array<{ value: string }> = payload?.data?.models ?? [];
        if (models.length === 0) {
          return;
        }
        setModelFor('codex', (current) => {
          if (models.some((m) => m.value === current)) {
            return current;
          }
          const nextModel = models[0].value;
          // session 的模型由還原 effect 非同步讀取，這裡只改顯示、不回寫，避免與其競態覆蓋記錄
          if (!selectedSession?.id) localStorage.setItem('codex-model', nextModel);
          return nextModel;
        });
      })
      .catch((error) => {
        console.error('Error loading Codex models:', error);
      });
  }, [provider, selectedSession?.id, selectedSession?.__provider, setModelFor]);

  useEffect(() => {
    if (provider !== 'antigravity' || (selectedSession?.__provider && selectedSession.__provider !== provider)) {
      return;
    }

    api.providerModels('antigravity')
      .then((response) => response.json())
      .then((payload) => {
        const models: Array<{ value: string }> = payload?.data?.models ?? [];
        if (models.length === 0) {
          return;
        }
        setModelFor('antigravity', (current) => {
          if (models.some((m) => m.value === current)) {
            return current;
          }
          const nextModel = models[0].value;
          // session 的模型由還原 effect 非同步讀取，這裡只改顯示、不回寫，避免與其競態覆蓋記錄
          if (!selectedSession?.id) localStorage.setItem('antigravity-model', nextModel);
          return nextModel;
        });
      })
      .catch((error) => {
        console.error('Error loading Antigravity models:', error);
      });
  }, [provider, selectedSession?.id, selectedSession?.__provider, setModelFor]);

  const cyclePermissionMode = useCallback(() => {
    const modes = PROVIDER_INFO[provider].permissionModes;

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    setPermissionMode(nextMode);

    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
  }, [permissionMode, provider, selectedSession?.id]);

  return {
    provider,
    setProvider,
    modelByProvider,
    setModelFor,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  };
}
