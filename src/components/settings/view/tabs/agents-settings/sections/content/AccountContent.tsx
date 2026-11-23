import { CheckCircle2, Download, Loader2, LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IS_PLATFORM } from '../../../../../../../constants/config';
import SessionProviderLogo from '../../../../../../llm-logo-provider/SessionProviderLogo';
import SettingsCard from '../../../../SettingsCard';
import SettingsRow from '../../../../SettingsRow';
import SettingsSection from '../../../../SettingsSection';
import type { AgentProvider, AuthStatus } from '../../../../../types/types';

type AccountContentProps = {
  agent: AgentProvider;
  authStatus: AuthStatus;
  onLogin: () => void;
  onInstall?: () => void;
};

const AGENT_NAMES: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export default function AccountContent({ agent, authStatus, onLogin, onInstall }: AccountContentProps) {
  const { t } = useTranslation('settings');
  const agentName = AGENT_NAMES[agent];
  const showInstallButton = !IS_PLATFORM && !authStatus.loading && (!authStatus.installed || Boolean(authStatus.installing)) && Boolean(onInstall);
  const showLoginButton = !authStatus.loading && authStatus.installed && !authStatus.installing && authStatus.method !== 'api_key';
  const showLoginSection = showLoginButton || showInstallButton;

  return (
    <div className="space-y-6">
      <SettingsSection title={t('tabs.account')}>
        <SettingsCard divided>
          <SettingsRow
            label={
              <span className="flex items-center gap-2.5">
                <SessionProviderLogo provider={agent} className="h-4 w-4" />
                <span>{t('agents.connectionStatus')}</span>
              </span>
            }
            description={
              authStatus.loading
                ? t('agents.authStatus.checkingAuth')
                : authStatus.authenticated
                  ? t('agents.authStatus.loggedInAs', {
                    email: authStatus.email || t('agents.authStatus.authenticatedUser'),
                  })
                  : t('agents.authStatus.notConnected')
            }
          >
            {authStatus.loading ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('agents.authStatus.checking')}
              </span>
            ) : authStatus.authenticated ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {t('agents.authStatus.connected')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
                {t('agents.authStatus.disconnected')}
              </span>
            )}
          </SettingsRow>

          {showLoginSection && (
            <SettingsRow
              label={authStatus.authenticated ? t('agents.login.reAuthenticate') : t('agents.login.title')}
              description={
                authStatus.authenticated
                  ? t('agents.login.reAuthDescription')
                  : t('agents.login.description', { agent: agentName })
              }
            >
              <div className="flex items-center gap-2">
                {showInstallButton && (
                  <button
                    type="button"
                    onClick={onInstall}
                    disabled={authStatus.installing}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    {authStatus.installing ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t('agents.install.installing', { defaultValue: 'Installing...' })}
                      </>
                    ) : (
                      <>
                        <Download className="h-3.5 w-3.5" />
                        {t('agents.install.button', { defaultValue: 'Install' })}
                      </>
                    )}
                  </button>
                )}
                {showLoginButton && (
                  <button
                    type="button"
                    onClick={onLogin}
                    disabled={authStatus.installing}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    <LogIn className="h-3.5 w-3.5" />
                    {authStatus.authenticated ? t('agents.login.reLoginButton') : t('agents.login.button')}
                  </button>
                )}
              </div>
            </SettingsRow>
          )}

          {authStatus.installSuccess && (
            <div className="flex items-center gap-2 px-5 py-3 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              <span>{t('agents.install.success', { defaultValue: 'CLI installed successfully' })}</span>
            </div>
          )}

          {authStatus.error && (
            <div className="px-5 py-3 text-xs text-destructive">
              {t('agents.error', { error: authStatus.error })}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
