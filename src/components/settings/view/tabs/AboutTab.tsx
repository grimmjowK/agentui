import { ExternalLink, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { currentVersion } from '../../../../hooks/useVersionCheck';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

const GITHUB_REPO_URL = 'https://github.com/grimmjowK/agentui';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

export default function AboutTab() {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-6">
      <SettingsSection title={t('mainTabs.about')}>
        <SettingsCard divided>
          <SettingsRow
            label={
              <span className="flex items-center gap-3">
                <img src="/logo-mark.svg" alt="" className="h-8 w-8 flex-shrink-0" />
                <span>EAO</span>
              </span>
            }
            description={t('about.description', { defaultValue: 'Open-source AI coding assistant interface' })}
          >
            <span className="rounded-lg bg-muted/60 px-2.5 py-1 font-mono text-xs font-medium text-muted-foreground">
              v{currentVersion}
            </span>
          </SettingsRow>

          <SettingsRow
            label="GitHub"
            description={t('about.license', { defaultValue: 'Licensed under AGPL-3.0' })}
          >
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <GitHubIcon className="h-3.5 w-3.5" />
              <Star className="h-3 w-3" />
              <span>{t('about.starOnGithub', { defaultValue: 'Star on GitHub' })}</span>
              <ExternalLink className="h-3 w-3 opacity-60" />
            </a>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
