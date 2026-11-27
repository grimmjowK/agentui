import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useServerPlatform } from '../../../../../hooks/useServerPlatform';
import { useAgentToggle } from '../../../../../hooks/useAgentToggle';
import Tooltip from '../../../../../shared/view/ui/Tooltip';
import SettingsCard from '../../SettingsCard';
import SettingsRow from '../../SettingsRow';
import SettingsToggle from '../../SettingsToggle';
import type { AgentCategory, AgentProvider } from '../../../types/types';

import type { AgentContext, AgentsSettingsTabProps } from './types';
import AgentCategoryContentSection from './sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from './sections/AgentCategoryTabsSection';
import AgentSelectorSection from './sections/AgentSelectorSection';

const AGENT_NAMES: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export default function AgentsSettingsTab({
  providerAuthStatus,
  onProviderLogin,
  onProviderInstall,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  antigravityPermissions,
  onAntigravityPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  projects,
}: AgentsSettingsTabProps) {
  const { t } = useTranslation('settings');
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>('claude');
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>('account');
  const { isWindowsServer } = useServerPlatform();
  const { enabledAgents, toggleAgent } = useAgentToggle();

  const visibleAgents = useMemo<AgentProvider[]>(() => {
    const all: AgentProvider[] = ['claude', 'cursor', 'codex', 'antigravity'];
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
      onInstall: () => onProviderInstall('claude'),
    },
    cursor: {
      authStatus: providerAuthStatus.cursor,
      onLogin: () => onProviderLogin('cursor'),
      onInstall: () => onProviderInstall('cursor'),
    },
    codex: {
      authStatus: providerAuthStatus.codex,
      onLogin: () => onProviderLogin('codex'),
      onInstall: () => onProviderInstall('codex'),
    },
    antigravity: {
      authStatus: providerAuthStatus.antigravity,
      onLogin: () => onProviderLogin('antigravity'),
      onInstall: () => onProviderInstall('antigravity'),
    },
  }), [
    onProviderLogin,
    onProviderInstall,
    providerAuthStatus.claude,
    providerAuthStatus.cursor,
    providerAuthStatus.codex,
    providerAuthStatus.antigravity,
  ]);

  const isSelectedAgentEnabled = enabledAgents[selectedAgent];
  const enabledCount = visibleAgents.filter((a) => enabledAgents[a]).length;
  const isLastEnabled = isSelectedAgentEnabled && enabledCount <= 1;

  return (
    <div className="space-y-6">
      <AgentSelectorSection
        agents={visibleAgents}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        agentContextById={agentContextById}
      />

      <SettingsCard>
        <SettingsRow
          label={`${t('agents.enable', { defaultValue: '启用' })} ${AGENT_NAMES[selectedAgent]}`}
          description={t(`agents.account.${selectedAgent}.description`)}
        >
          {isLastEnabled ? (
            <Tooltip content={t('agents.lastEnabledTooltip', { defaultValue: 'At least one agent must be enabled' })}>
              <div>
                <SettingsToggle
                  checked={isSelectedAgentEnabled}
                  disabled={true}
                  onChange={() => {}}
                  ariaLabel={`${AGENT_NAMES[selectedAgent]} toggle`}
                />
              </div>
            </Tooltip>
          ) : (
            <SettingsToggle
              checked={isSelectedAgentEnabled}
              disabled={false}
              onChange={(v) => void toggleAgent(selectedAgent, v)}
              ariaLabel={`${AGENT_NAMES[selectedAgent]} toggle`}
            />
          )}
        </SettingsRow>
      </SettingsCard>

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
          antigravityPermissions={antigravityPermissions}
          onAntigravityPermissionsChange={onAntigravityPermissionsChange}
          codexPermissionMode={codexPermissionMode}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          projects={projects}
        />
      </div>
    </div>
  );
}
