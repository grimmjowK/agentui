import { useCallback, useEffect, useRef, useState } from 'react';

import { api, authenticatedFetch } from '../../../utils/api';
import {
  ANTIGRAVITY_MODELS,
  CLAUDE_MODELS,
  CODEX_MODELS,
  CURSOR_MODELS,
  GEMINI_MODELS,
} from '../../../../shared/modelConstants';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';

const getPermissionModesForProvider = (provider: LLMProvider): PermissionMode[] => {
  if (provider === 'codex') {
    return ['default', 'acceptEdits', 'bypassPermissions'];
  }
  if (provider === 'antigravity') {
    return ['default', 'bypassPermissions'];
  }
  if (provider === 'claude') {
    return ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'];
  }
  return ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
};

const antigravityDefaultMode = (): PermissionMode => {
  try {
    const settings = JSON.parse(localStorage.getItem('antigravity-settings') || '{}');
    return settings.explicitConsent === true && settings.skipPermissions === true
      ? 'bypassPermissions' : 'default';
  } catch {
    return 'default';
  }
};

const MODEL_DEFAULTS: Record<LLMProvider, string> = {
  claude: CLAUDE_MODELS.DEFAULT,
  cursor: CURSOR_MODELS.DEFAULT,
  codex: CODEX_MODELS.DEFAULT,
  gemini: GEMINI_MODELS.DEFAULT,
  antigravity: ANTIGRAVITY_MODELS.DEFAULT,
};

// 全域預設模型：新 session 使用，也是無記錄的存量 session 的回退值
const getDefaultModel = (provider: LLMProvider): string =>
  localStorage.getItem(`${provider}-model`) || MODEL_DEFAULTS[provider];

// 已有 session 的模型按 session 保存，避免一個 session 的切換影響其他 session
export const sessionModelKey = (sessionId: string) => `session-model-${sessionId}`;

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
}

export function useChatProviderState({ selectedSession }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => (
    localStorage.getItem('selected-provider') === 'antigravity' ? antigravityDefaultMode() : 'default'
  ));
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [provider, setProvider] = useState<LLMProvider>(() => {
    return (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
  });
  const [cursorModel, setCursorModel] = useState<string>(() => {
    return localStorage.getItem('cursor-model') || CURSOR_MODELS.DEFAULT;
  });
  const [claudeModel, setClaudeModel] = useState<string>(() => {
    return localStorage.getItem('claude-model') || CLAUDE_MODELS.DEFAULT;
  });
  const [codexModel, setCodexModel] = useState<string>(() => {
    return localStorage.getItem('codex-model') || CODEX_MODELS.DEFAULT;
  });
  const [geminiModel, setGeminiModel] = useState<string>(() => {
    return localStorage.getItem('gemini-model') || GEMINI_MODELS.DEFAULT;
  });
  const [antigravityModel, setAntigravityModel] = useState<string>(() => {
    return localStorage.getItem('antigravity-model') || ANTIGRAVITY_MODELS.DEFAULT;
  });

  const lastProviderRef = useRef(provider);

  // 切換 session（或回到新 session 畫面）時還原該 session 的模型
  useEffect(() => {
    const sessionId = selectedSession?.id;
    // provider 尚未切到該 session 的 provider 時先跳過，等下一輪 effect
    if (selectedSession?.__provider && selectedSession.__provider !== provider) {
      return;
    }
    const model = (sessionId && localStorage.getItem(sessionModelKey(sessionId))) || getDefaultModel(provider);
    const setters: Record<LLMProvider, (model: string) => void> = {
      claude: setClaudeModel,
      cursor: setCursorModel,
      codex: setCodexModel,
      gemini: setGeminiModel,
      antigravity: setAntigravityModel,
    };
    setters[provider](model);
  }, [selectedSession?.id, selectedSession?.__provider, provider]);

  useEffect(() => {
    if (!selectedSession?.id) {
      setPermissionMode(provider === 'antigravity' ? antigravityDefaultMode() : 'default');
      return;
    }

    const savedMode = localStorage.getItem(`permissionMode-${selectedSession.id}`) as PermissionMode | null;
    const validModes = getPermissionModesForProvider(provider);
    setPermissionMode(savedMode && validModes.includes(savedMode)
      ? savedMode : provider === 'antigravity' ? antigravityDefaultMode() : 'default');
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
    if (lastProviderRef.current === provider) {
      return;
    }
    setPendingPermissionRequests([]);
    lastProviderRef.current = provider;
  }, [provider]);

  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

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
          setCursorModel(modelId);
        }
      })
      .catch((error) => {
        console.error('Error loading Cursor config:', error);
      });
  }, [provider]);

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
        setCodexModel((current) => {
          if (models.some((m) => m.value === current)) {
            return current;
          }
          const nextModel = models[0].value;
          localStorage.setItem(selectedSession?.id ? sessionModelKey(selectedSession.id) : 'codex-model', nextModel);
          return nextModel;
        });
      })
      .catch((error) => {
        console.error('Error loading Codex models:', error);
      });
  }, [provider, selectedSession?.id, selectedSession?.__provider]);

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
        setAntigravityModel((current) => {
          if (models.some((m) => m.value === current)) {
            return current;
          }
          const nextModel = models[0].value;
          localStorage.setItem(selectedSession?.id ? sessionModelKey(selectedSession.id) : 'antigravity-model', nextModel);
          return nextModel;
        });
      })
      .catch((error) => {
        console.error('Error loading Antigravity models:', error);
      });
  }, [provider, selectedSession?.id, selectedSession?.__provider]);

  const cyclePermissionMode = useCallback(() => {
    const modes = getPermissionModesForProvider(provider);

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
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    geminiModel,
    setGeminiModel,
    antigravityModel,
    setAntigravityModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  };
}
