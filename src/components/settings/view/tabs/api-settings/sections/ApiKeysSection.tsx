import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SettingsCard from '../../../SettingsCard';
import SettingsRow from '../../../SettingsRow';
import SettingsSection from '../../../SettingsSection';
import SettingsToggle from '../../../SettingsToggle';
import type { ApiKeyItem } from '../types';

type ApiKeysSectionProps = {
  apiKeys: ApiKeyItem[];
  showNewKeyForm: boolean;
  newKeyName: string;
  onShowNewKeyFormChange: (value: boolean) => void;
  onNewKeyNameChange: (value: string) => void;
  onCreateApiKey: () => void;
  onCancelCreateApiKey: () => void;
  onToggleApiKey: (keyId: string, isActive: boolean) => void;
  onDeleteApiKey: (keyId: string) => void;
};

export default function ApiKeysSection({
  apiKeys,
  showNewKeyForm,
  newKeyName,
  onShowNewKeyFormChange,
  onNewKeyNameChange,
  onCreateApiKey,
  onCancelCreateApiKey,
  onToggleApiKey,
  onDeleteApiKey,
}: ApiKeysSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <SettingsSection
      title={t('apiKeys.title')}
      description={t('apiKeys.description')}
    >
      <SettingsCard divided>
        <SettingsRow
          label={t('apiKeys.title')}
          description={
            <a
              href="/api-docs.html"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {t('apiKeys.apiDocsLink')}
              <ExternalLink className="h-3 w-3" />
            </a>
          }
        >
          <button
            type="button"
            onClick={() => onShowNewKeyFormChange(!showNewKeyForm)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{t('apiKeys.newButton')}</span>
          </button>
        </SettingsRow>

        {showNewKeyForm && (
          <div className="space-y-3 bg-muted/15 px-5 py-4">
            <input
              type="text"
              placeholder={t('apiKeys.form.placeholder')}
              value={newKeyName}
              onChange={(event) => onNewKeyNameChange(event.target.value)}
              className="h-9 w-full rounded-xl border border-border/70 bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancelCreateApiKey}
                className="h-8 rounded-lg border border-border/70 bg-muted/40 px-3 text-xs font-medium text-foreground hover:bg-muted"
              >
                {t('apiKeys.form.cancelButton')}
              </button>
              <button
                type="button"
                onClick={onCreateApiKey}
                disabled={!newKeyName.trim()}
                className="h-8 rounded-lg bg-foreground px-3.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-40"
              >
                {t('apiKeys.form.createButton')}
              </button>
            </div>
          </div>
        )}

        {apiKeys.length === 0 ? (
          <div className="px-5 py-6 text-center text-xs text-muted-foreground">
            {t('apiKeys.empty')}
          </div>
        ) : (
          apiKeys.map((key) => (
            <SettingsRow
              key={key.id}
              label={
                <span className="flex items-center gap-2">
                  <span>{key.key_name}</span>
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] font-normal text-muted-foreground">
                    {key.api_key}
                  </code>
                </span>
              }
              description={
                <span>
                  {t('apiKeys.list.created')} {new Date(key.created_at).toLocaleDateString()}
                  {key.last_used
                    ? ` · ${t('apiKeys.list.lastUsed')} ${new Date(key.last_used).toLocaleDateString()}`
                    : ''}
                </span>
              }
            >
              <div className="flex items-center gap-3">
                <SettingsToggle
                  checked={key.is_active}
                  onChange={() => onToggleApiKey(key.id, key.is_active)}
                  ariaLabel={key.key_name}
                />
                <button
                  type="button"
                  onClick={() => onDeleteApiKey(key.id)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Delete API key"
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
