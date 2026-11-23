import { AlertCircle, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useGitSettings } from '../../../hooks/useGitSettings';
import SettingsCard from '../../SettingsCard';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';

export default function GitSettingsTab() {
  const { t } = useTranslation('settings');
  const {
    gitName,
    setGitName,
    gitEmail,
    setGitEmail,
    isLoading,
    isSaving,
    saveStatus,
    saveError,
    saveGitConfig,
  } = useGitSettings();

  return (
    <div className="space-y-7">
      <SettingsSection
        title={t('git.title')}
        description={t('git.description')}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t('git.name.label')}
            description={t('git.name.help')}
          >
            <input
              id="settings-git-name"
              type="text"
              value={gitName}
              onChange={(event) => setGitName(event.target.value)}
              placeholder="John Doe"
              disabled={isLoading}
              className="h-8 w-52 rounded-lg border border-border/70 bg-muted/30 px-3 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:bg-background focus:outline-none disabled:opacity-50"
            />
          </SettingsRow>

          <SettingsRow
            label={t('git.email.label')}
            description={t('git.email.help')}
          >
            <input
              id="settings-git-email"
              type="email"
              value={gitEmail}
              onChange={(event) => setGitEmail(event.target.value)}
              placeholder="john@example.com"
              disabled={isLoading}
              className="h-8 w-52 rounded-lg border border-border/70 bg-muted/30 px-3 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:bg-background focus:outline-none disabled:opacity-50"
            />
          </SettingsRow>

          <div className="flex items-center justify-between gap-3 px-5 py-3.5">
            <div className="text-xs">
              {saveStatus === 'success' && (
                <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3.5 w-3.5" />
                  {t('git.status.success')}
                </span>
              )}
              {saveStatus === 'error' && (
                <span className="inline-flex items-center gap-1.5 text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                  {saveError || t('git.status.error')}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={saveGitConfig}
              disabled={isSaving || !gitName.trim() || !gitEmail.trim()}
              className="inline-flex h-8 items-center rounded-lg border border-border/70 bg-muted/40 px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
            >
              {isSaving ? t('git.actions.saving') : t('git.actions.save')}
            </button>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
