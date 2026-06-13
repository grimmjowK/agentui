import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useServerPlatform } from '../../../../../hooks/useServerPlatform';
import { useAgentToggle } from '../../../../../hooks/useAgentToggle';
import Tooltip from '../../../../../shared/view/ui/Tooltip';
import type { AgentCategory, AgentProvider } from '../../../types/types';

import type { AgentContext, AgentsSettingsTabProps } from './types';
import AgentCategoryContentSection from './sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from './sections/AgentCategoryTabsSection';
import AgentSelectorSection from './sections/AgentSelectorSection';

const AGENT_NAMES: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
};

function AgentToggleSwitch({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <label className="relative inline-flex cursor-pointer select-none items-center">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
      />
      <div className="h-4 w-7 rounded-full bg-muted-foreground/30 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-3 after:w-3 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-3 peer-disabled:cursor-not-allowed peer-disabled:opacity-50" />
    </label>
  );
}

export default function AgentsSettingsTab({
  providerAuthStatus,
  onProviderLogin,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  geminiPermissionMode,
  onGeminiPermissionModeChange,
  projects,
}: AgentsSettingsTabProps) {
  const { t } = useTranslation('settings');
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>('claude');
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>('account');
  const { isWindowsServer } = useServerPlatform();
  const { enabledAgents, toggleAgent } = useAgentToggle();

  const visibleAgents = useMemo<AgentProvider[]>(() => {
    const all: AgentProvider[] = ['claude', 'cursor', 'codex', 'gemini'];
    if (isWindowsServer) {
      return all.filter((id) => id !== 'cursor');
    }

    return all;
  }, [isWindowsServer]);

  useEffect(() => {
    if (isWindowsServer && selectedAgent === 'cursor') {
      setSelectedAgent('claude');
    }
  }, [isWindowsServer, selectedAgent]);

  const agentContextById = useMemo<Record<AgentProvider, AgentContext>>(() => ({
    claude: {
      authStatus: providerAuthStatus.claude,
      onLogin: () => onProviderLogin('claude'),
    },
    cursor: {
      authStatus: providerAuthStatus.cursor,
      onLogin: () => onProviderLogin('cursor'),
    },
    codex: {
      authStatus: providerAuthStatus.codex,
      onLogin: () => onProviderLogin('codex'),
    },
    gemini: {
      authStatus: providerAuthStatus.gemini,
      onLogin: () => onProviderLogin('gemini'),
    },
  }), [
    onProviderLogin,
    providerAuthStatus.claude,
    providerAuthStatus.codex,
    providerAuthStatus.cursor,
    providerAuthStatus.gemini,
  ]);

  const isSelectedAgentEnabled = enabledAgents[selectedAgent];
  const enabledCount = visibleAgents.filter((a) => enabledAgents[a]).length;
  const isLastEnabled = isSelectedAgentEnabled && enabledCount <= 1;

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      <AgentSelectorSection
        agents={visibleAgents}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        agentContextById={agentContextById}
      />

      <div className="flex items-center justify-between border-b border-border px-3 py-2 md:px-4">
        <span className="text-xs text-muted-foreground">
          {isSelectedAgentEnabled
            ? t('agents.enable', { defaultValue: 'Enable' })
            : t('agents.disable', { defaultValue: 'Disable' })}
          {' '}{AGENT_NAMES[selectedAgent]}
        </span>
        {isLastEnabled ? (
          <Tooltip content={t('agents.lastEnabledTooltip', { defaultValue: 'At least one agent must be enabled' })}>
            <AgentToggleSwitch
              checked={isSelectedAgentEnabled}
              disabled={true}
              onChange={() => {}}
              ariaLabel={`${AGENT_NAMES[selectedAgent]} toggle`}
            />
          </Tooltip>
        ) : (
          <AgentToggleSwitch
            checked={isSelectedAgentEnabled}
            disabled={false}
            onChange={(v) => void toggleAgent(selectedAgent, v)}
            ariaLabel={`${isSelectedAgentEnabled ? t('agents.disable', { defaultValue: 'Disable' }) : t('agents.enable', { defaultValue: 'Enable' })} ${AGENT_NAMES[selectedAgent]}`}
          />
        )}
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <AgentCategoryTabsSection
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
        />

        <div className={!isSelectedAgentEnabled ? 'pointer-events-none opacity-50' : ''}>
          <AgentCategoryContentSection
            selectedAgent={selectedAgent}
            selectedCategory={selectedCategory}
            agentContextById={agentContextById}
            claudePermissions={claudePermissions}
            onClaudePermissionsChange={onClaudePermissionsChange}
            cursorPermissions={cursorPermissions}
            onCursorPermissionsChange={onCursorPermissionsChange}
            codexPermissionMode={codexPermissionMode}
            onCodexPermissionModeChange={onCodexPermissionModeChange}
            geminiPermissionMode={geminiPermissionMode}
            onGeminiPermissionModeChange={onGeminiPermissionModeChange}
            projects={projects}
          />
        </div>
      </div>
    </div>
  );
}
