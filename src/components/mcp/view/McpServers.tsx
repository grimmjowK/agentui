import { Check, Edit3, Globe, Loader2, Plus, Server, Terminal, Trash2, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { McpProject, McpProvider, McpScope, ProviderMcpServer } from '../types';
import {
  MCP_GLOBAL_SUPPORTED_SCOPES,
  MCP_GLOBAL_SUPPORTED_TRANSPORTS,
  MCP_PROVIDER_NAMES,
} from '../constants';
import { useMcpServers } from '../hooks/useMcpServers';
import { maskSecret } from '../utils/mcpFormatting';
import SettingsCard from '../../settings/view/SettingsCard';
import SettingsRow from '../../settings/view/SettingsRow';
import SettingsSection from '../../settings/view/SettingsSection';

import McpServerFormModal from './modals/McpServerFormModal';

type McpServersProps = {
  selectedProvider: McpProvider;
  currentProjects: McpProject[];
};

const getTransportIcon = (transport: string | undefined) => {
  if (transport === 'stdio') {
    return <Terminal className="h-4 w-4 text-muted-foreground" />;
  }
  if (transport === 'sse') {
    return <Zap className="h-4 w-4 text-muted-foreground" />;
  }
  if (transport === 'http') {
    return <Globe className="h-4 w-4 text-muted-foreground" />;
  }
  return <Server className="h-4 w-4 text-muted-foreground" />;
};

const getScopeLabel = (scope: McpScope): string => {
  if (scope === 'user') return 'user';
  if (scope === 'local') return 'local';
  return 'project';
};

const getServerKey = (server: ProviderMcpServer): string => (
  `${server.provider}:${server.scope}:${server.workspacePath || 'global'}:${server.name}`
);

function ConfigLine({ label, children }: { label: string; children: string }) {
  if (!children) return null;
  return (
    <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
      <span className="flex-shrink-0 text-muted-foreground/70">{label}:</span>
      <code className="break-all rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground/85">
        {children}
      </code>
    </div>
  );
}

export default function McpServers({ selectedProvider, currentProjects }: McpServersProps) {
  const { t } = useTranslation('settings');
  const {
    servers,
    isLoading,
    isLoadingProjectScopes,
    loadError,
    deleteError,
    saveStatus,
    isFormOpen,
    isGlobalFormOpen,
    editingServer,
    openForm,
    openGlobalForm,
    closeForm,
    closeGlobalForm,
    submitForm,
    submitGlobalForm,
    deleteServer,
  } = useMcpServers({ selectedProvider, currentProjects });

  const providerName = MCP_PROVIDER_NAMES[selectedProvider];
  const description = t(`mcpServers.description.${selectedProvider}`, {
    defaultValue: `Model Context Protocol servers provide additional tools and data sources to ${providerName}`,
  });
  const globalButtonLabel = t('mcpServers.addGlobalButton', { defaultValue: 'Add Globally' });
  const providerButtonLabel = t('mcpServers.addProviderButton', {
    provider: providerName,
    defaultValue: `Add to ${providerName}`,
  });
  const globalAddDescription = t('mcpServers.globalAddDescription', {
    defaultValue: 'Add the same stdio or HTTP MCP server across Claude, Cursor, Codex, and Antigravity.',
  });
  const providerAddDescription = t('mcpServers.providerAddDescription', {
    provider: providerName,
    defaultValue: `Add this MCP server only to ${providerName}.`,
  });
  const globalModalDescription = t('mcpServers.globalModalDescription', {
    defaultValue: 'Sync this MCP server across Claude, Cursor, Codex, and Antigravity (supports stdio and HTTP transports).',
  });

  return (
    <div className="space-y-6">
      <SettingsSection title={t('mcpServers.title')} description={description}>
        <SettingsCard divided>
          <SettingsRow
            label={t('mcpServers.addButton')}
            description={
              saveStatus === 'success' ? (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3 w-3" />
                  {t('saveStatus.success')}
                </span>
              ) : isLoadingProjectScopes ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('mcpServers.syncingProjectScopes', { defaultValue: 'Syncing project-level configurations...' })}
                </span>
              ) : (
                globalAddDescription
              )
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={openGlobalForm}
                title={globalAddDescription}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{globalButtonLabel}</span>
              </button>
              <button
                type="button"
                onClick={() => openForm()}
                title={providerAddDescription}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{providerButtonLabel}</span>
              </button>
            </div>
          </SettingsRow>

          {(loadError || deleteError) && (
            <div className="px-5 py-3 text-xs text-destructive">
              {deleteError || loadError}
            </div>
          )}

          {isLoading && servers.length === 0 && (
            <div className="flex items-center justify-center gap-2 px-5 py-8 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{t('mcpServers.loading', { defaultValue: 'Loading MCP servers...' })}</span>
            </div>
          )}

          {!isLoading && !isLoadingProjectScopes && servers.length === 0 && (
            <div className="px-5 py-8 text-center text-xs text-muted-foreground">
              {t('mcpServers.empty')}
            </div>
          )}

          {servers.map((server) => (
            <div
              key={getServerKey(server)}
              className="flex items-start justify-between gap-4 px-5 py-4 transition-colors hover:bg-muted/20"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-muted/60">
                    {getTransportIcon(server.transport)}
                  </span>
                  <span className="text-[14px] font-medium text-foreground">{server.name}</span>
                  <span className="rounded-md bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {server.transport || 'stdio'}
                  </span>
                  <span className="rounded-md bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                    {getScopeLabel(server.scope)}
                  </span>
                  {server.projectDisplayName && (
                    <span className="max-w-[200px] truncate rounded-md bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                      {server.projectDisplayName}
                    </span>
                  )}
                </div>

                <div className="mt-2 space-y-1 pl-8">
                  <ConfigLine label={t('mcpServers.config.command')}>{server.command || ''}</ConfigLine>
                  <ConfigLine label={t('mcpServers.config.url')}>{server.url || ''}</ConfigLine>
                  <ConfigLine label={t('mcpServers.config.args')}>{(server.args || []).join(' ')}</ConfigLine>
                  <ConfigLine label="Cwd">{server.cwd || ''}</ConfigLine>
                  {server.env && Object.keys(server.env).length > 0 && (
                    <ConfigLine label={t('mcpServers.config.environment')}>
                      {Object.entries(server.env).map(([key, value]) => `${key}=${maskSecret(value)}`).join(', ')}
                    </ConfigLine>
                  )}
                  {server.envVars && server.envVars.length > 0 && (
                    <ConfigLine label="Env Vars">{server.envVars.join(', ')}</ConfigLine>
                  )}
                </div>
              </div>

              <div className="flex flex-shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => openForm(server)}
                  title={t('mcpServers.actions.edit')}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => deleteServer(server)}
                  title={t('mcpServers.actions.delete')}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>

      {selectedProvider === 'codex' && (
        <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <strong className="font-medium text-foreground/85">{t('mcpServers.help.title')}：</strong>
          {t('mcpServers.help.description')}
        </div>
      )}

      <McpServerFormModal
        provider={selectedProvider}
        isOpen={isFormOpen}
        editingServer={editingServer}
        currentProjects={currentProjects}
        title={editingServer ? undefined : providerButtonLabel}
        submitLabel={providerButtonLabel}
        onClose={closeForm}
        onSubmit={submitForm}
      />

      <McpServerFormModal
        provider={selectedProvider}
        mode="global"
        isOpen={isGlobalFormOpen}
        editingServer={null}
        currentProjects={currentProjects}
        title={globalButtonLabel}
        description={globalModalDescription}
        submitLabel={globalButtonLabel}
        supportedScopes={MCP_GLOBAL_SUPPORTED_SCOPES}
        supportedTransports={MCP_GLOBAL_SUPPORTED_TRANSPORTS}
        onClose={closeGlobalForm}
        onSubmit={(formData) => submitGlobalForm(formData)}
      />
    </div>
  );
}
