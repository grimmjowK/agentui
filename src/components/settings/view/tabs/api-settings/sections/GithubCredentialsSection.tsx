import { ExternalLink, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SettingsCard from '../../../SettingsCard';
import SettingsRow from '../../../SettingsRow';
import SettingsSection from '../../../SettingsSection';
import SettingsToggle from '../../../SettingsToggle';
import type { GithubCredentialItem } from '../types';

type GithubCredentialsSectionProps = {
  githubCredentials: GithubCredentialItem[];
  showNewGithubForm: boolean;
  showNewTokenPlainText: boolean;
  newGithubName: string;
  newGithubToken: string;
  newGithubDescription: string;
  onShowNewGithubFormChange: (value: boolean) => void;
  onNewGithubNameChange: (value: string) => void;
  onNewGithubTokenChange: (value: string) => void;
  onNewGithubDescriptionChange: (value: string) => void;
  onToggleNewTokenVisibility: () => void;
  onCreateGithubCredential: () => void;
  onCancelCreateGithubCredential: () => void;
  onToggleGithubCredential: (credentialId: string, isActive: boolean) => void;
  onDeleteGithubCredential: (credentialId: string) => void;
};

export default function GithubCredentialsSection({
  githubCredentials,
  showNewGithubForm,
  showNewTokenPlainText,
  newGithubName,
  newGithubToken,
  newGithubDescription,
  onShowNewGithubFormChange,
  onNewGithubNameChange,
  onNewGithubTokenChange,
  onNewGithubDescriptionChange,
  onToggleNewTokenVisibility,
  onCreateGithubCredential,
  onCancelCreateGithubCredential,
  onToggleGithubCredential,
  onDeleteGithubCredential,
}: GithubCredentialsSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <SettingsSection
      title={t('apiKeys.github.title')}
      description={t('apiKeys.github.descriptionAlt')}
    >
      <SettingsCard divided>
        <SettingsRow
          label={t('apiKeys.github.title')}
          description={
            <a
              href="https://github.com/settings/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {t('apiKeys.github.form.howToCreate')}
              <ExternalLink className="h-3 w-3" />
            </a>
          }
        >
          <button
            type="button"
            onClick={() => onShowNewGithubFormChange(!showNewGithubForm)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{t('apiKeys.github.addButton')}</span>
          </button>
        </SettingsRow>

        {showNewGithubForm && (
          <div className="space-y-3 bg-muted/15 px-5 py-4">
            <input
              type="text"
              placeholder={t('apiKeys.github.form.namePlaceholder')}
              value={newGithubName}
              onChange={(event) => onNewGithubNameChange(event.target.value)}
              className="h-9 w-full rounded-xl border border-border/70 bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
            />

            <div className="relative">
              <input
                type={showNewTokenPlainText ? 'text' : 'password'}
                placeholder={t('apiKeys.github.form.tokenPlaceholder')}
                value={newGithubToken}
                onChange={(event) => onNewGithubTokenChange(event.target.value)}
                className="h-9 w-full rounded-xl border border-border/70 bg-background pl-3 pr-9 font-mono text-xs text-foreground placeholder:font-sans placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
              />
              <button
                type="button"
                onClick={onToggleNewTokenVisibility}
                aria-label={showNewTokenPlainText ? 'Hide token' : 'Show token'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showNewTokenPlainText ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>

            <input
              type="text"
              placeholder={t('apiKeys.github.form.descriptionPlaceholder')}
              value={newGithubDescription}
              onChange={(event) => onNewGithubDescriptionChange(event.target.value)}
              className="h-9 w-full rounded-xl border border-border/70 bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
            />

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancelCreateGithubCredential}
                className="h-8 rounded-lg border border-border/70 bg-muted/40 px-3 text-xs font-medium text-foreground hover:bg-muted"
              >
                {t('apiKeys.github.form.cancelButton')}
              </button>
              <button
                type="button"
                onClick={onCreateGithubCredential}
                disabled={!newGithubName.trim() || !newGithubToken.trim()}
                className="h-8 rounded-lg bg-foreground px-3.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-40"
              >
                {t('apiKeys.github.form.addButton')}
              </button>
            </div>
          </div>
        )}

        {githubCredentials.length === 0 ? (
          <div className="px-5 py-6 text-center text-xs text-muted-foreground">
            {t('apiKeys.github.empty')}
          </div>
        ) : (
          githubCredentials.map((credential) => (
            <SettingsRow
              key={credential.id}
              label={credential.credential_name}
              description={
                <span>
                  {credential.description ? `${credential.description} · ` : ''}
                  {t('apiKeys.github.added')} {new Date(credential.created_at).toLocaleDateString()}
                </span>
              }
            >
              <div className="flex items-center gap-3">
                <SettingsToggle
                  checked={credential.is_active}
                  onChange={() => onToggleGithubCredential(credential.id, credential.is_active)}
                  ariaLabel={credential.credential_name}
                />
                <button
                  type="button"
                  onClick={() => onDeleteGithubCredential(credential.id)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Delete GitHub credential"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </SettingsRow>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
