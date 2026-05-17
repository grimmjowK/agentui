import { useCallback, useEffect, useState } from 'react';
import { authenticatedFetch } from '../utils/api';
import type { LLMProvider } from '../types/app';

type AgentToggleState = Record<LLMProvider, boolean>;

const DEFAULT_STATE: AgentToggleState = {
  claude: true,
  cursor: true,
  codex: true,
  gemini: true,
};

export function useAgentToggle() {
  const [enabledAgents, setEnabledAgents] = useState<AgentToggleState>(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    authenticatedFetch('/api/settings/agent-toggle')
      .then((res) => res.json())
      .then((data: AgentToggleState) => {
        setEnabledAgents({ ...DEFAULT_STATE, ...data });
        setLoaded(true);
      })
      .catch(() => {
        setLoaded(true);
      });
  }, []);

  const toggleAgent = useCallback(
    async (provider: LLMProvider, enabled: boolean) => {
      if (!enabled) {
        const enabledCount = Object.values(enabledAgents).filter(Boolean).length;
        if (enabledCount <= 1) {
          return false;
        }
      }

      const next = { ...enabledAgents, [provider]: enabled };
      setEnabledAgents(next);

      try {
        const res = await authenticatedFetch('/api/settings/agent-toggle', {
          method: 'PUT',
          body: JSON.stringify({ [provider]: enabled }),
        });
        const data: AgentToggleState = await res.json();
        setEnabledAgents({ ...DEFAULT_STATE, ...data });
        return true;
      } catch {
        setEnabledAgents(enabledAgents);
        return false;
      }
    },
    [enabledAgents],
  );

  return { enabledAgents, toggleAgent, loaded };
}
