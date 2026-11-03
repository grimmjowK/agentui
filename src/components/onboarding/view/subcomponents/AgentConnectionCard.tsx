import { Check, Download, Loader2 } from 'lucide-react';
import { IS_PLATFORM } from '../../../../constants/config';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { LLMProvider } from '../../../../types/app';
import type { ProviderAuthStatus } from '../../../provider-auth/types';

type AgentConnectionCardProps = {
  provider: LLMProvider;
  title: string;
  status: ProviderAuthStatus;
  connectedClassName: string;
  iconContainerClassName: string;
  loginButtonClassName: string;
  onLogin: () => void;
  onInstall?: () => void;
};

export default function AgentConnectionCard({
  provider,
  title,
  status,
  connectedClassName,
  iconContainerClassName,
  loginButtonClassName,
  onLogin,
  onInstall,
}: AgentConnectionCardProps) {
  const isReady = status.authenticated && status.installed;
  const showInstallButton = !IS_PLATFORM && !status.loading && (!status.installed || Boolean(status.installing)) && Boolean(onInstall);
  const showLoginButton = !status.loading && status.installed && !status.installing && !status.authenticated;
  const containerClassName = isReady ? connectedClassName : 'border-border bg-card';

  const statusText = status.loading
    ? 'Checking...'
    : status.installing
      ? 'Installing CLI...'
    : isReady
      ? status.installSuccess
        ? `Installed & connected (${status.email || 'Connected'})`
        : status.email || 'Connected'
      : status.installSuccess
        ? 'CLI installed successfully — click Login to connect'
      : status.error || 'Not connected';

  const statusTextClassName = !status.loading && !status.installing && !isReady && status.error && !status.installSuccess
    ? 'text-xs text-red-600 dark:text-red-400'
    : status.installSuccess
      ? 'text-xs text-green-600 dark:text-green-400'
      : 'text-xs text-muted-foreground';

  return (
    <div className={`rounded-lg border p-4 transition-colors ${containerClassName}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${iconContainerClassName}`}>
            <SessionProviderLogo provider={provider} className="h-5 w-5" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 font-medium text-foreground">
              {title}
              {isReady && <Check className="h-4 w-4 text-green-500" />}
            </div>
            <div className={`break-words ${statusTextClassName}`}>{statusText}</div>
          </div>
        </div>

        {(showInstallButton || showLoginButton) && (
          <div className="flex flex-shrink-0 items-center gap-2">
            {showInstallButton && (
              <button
                onClick={onInstall}
                disabled={status.installing}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                {status.installing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Installing...
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4" />
                    Install
                  </>
                )}
              </button>
            )}
            {showLoginButton && (
              <button
                onClick={onLogin}
                disabled={status.installing}
                className={`${loginButtonClassName} rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50`}
              >
                Login
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
