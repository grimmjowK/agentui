import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SettingsCard from '../../../../SettingsCard';
import SettingsRow from '../../../../SettingsRow';
import SettingsSection from '../../../../SettingsSection';
import SettingsToggle from '../../../../SettingsToggle';
import type { AntigravityPermissionMode, CodexPermissionMode } from '../../../../../types/types';

const COMMON_CLAUDE_TOOLS = [
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Write',
  'Read',
  'Edit',
  'Glob',
  'Grep',
  'MultiEdit',
  'Task',
  'TodoWrite',
  'TodoRead',
  'WebFetch',
  'WebSearch',
];

const COMMON_CURSOR_COMMANDS = [
  'Shell(ls)',
  'Shell(mkdir)',
  'Shell(cd)',
  'Shell(cat)',
  'Shell(echo)',
  'Shell(git status)',
  'Shell(git diff)',
  'Shell(git log)',
  'Shell(npm install)',
  'Shell(npm run)',
  'Shell(python)',
  'Shell(node)',
];

const addUnique = (items: string[], value: string): string[] => {
  const normalizedValue = value.trim();
  if (!normalizedValue || items.includes(normalizedValue)) {
    return items;
  }
  return [...items, normalizedValue];
};

const removeValue = (items: string[], value: string): string[] => (
  items.filter((item) => item !== value)
);

type RuleListEditorProps = {
  title: string;
  description: string;
  placeholder: string;
  emptyText: string;
  addLabel: string;
  items: string[];
  onChange: (items: string[]) => void;
  quickAddTitle?: string;
  quickAddItems?: string[];
};

function RuleListEditor({
  title,
  description,
  placeholder,
  emptyText,
  addLabel,
  items,
  onChange,
  quickAddTitle,
  quickAddItems,
}: RuleListEditorProps) {
  const [draft, setDraft] = useState('');

  const handleAdd = (value: string) => {
    const updated = addUnique(items, value);
    if (updated.length === items.length) return;
    onChange(updated);
    setDraft('');
  };

  return (
    <SettingsSection title={title} description={description}>
      <SettingsCard divided>
        <div className="p-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={placeholder}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleAdd(draft);
                }
              }}
              className="h-9 flex-1 rounded-xl border border-border/70 bg-muted/30 px-3 text-xs font-mono text-foreground placeholder:font-sans placeholder:text-muted-foreground/70 focus:border-primary focus:bg-background focus:outline-none"
            />
            <button
              type="button"
              onClick={() => handleAdd(draft)}
              disabled={!draft.trim()}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border/70 bg-muted/40 px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{addLabel}</span>
            </button>
          </div>

          {quickAddItems && quickAddItems.length > 0 && (
            <div className="mt-3">
              {quickAddTitle && (
                <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                  {quickAddTitle}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {quickAddItems.map((item) => {
                  const exists = items.includes(item);
                  return (
                    <button
                      key={item}
                      type="button"
                      disabled={exists}
                      onClick={() => handleAdd(item)}
                      className="rounded-lg border border-border/60 bg-muted/25 px-2 py-1 font-mono text-[11px] text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-35"
                    >
                      + {item}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-3.5">
          {items.length === 0 ? (
            <div className="py-2 text-center text-xs text-muted-foreground">
              {emptyText}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {items.map((item) => (
                <span
                  key={item}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1 font-mono text-xs text-foreground"
                >
                  <span>{item}</span>
                  <button
                    type="button"
                    onClick={() => onChange(removeValue(items, item))}
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                    aria-label={`Remove ${item}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

type ClaudePermissionsProps = {
  agent: 'claude';
  skipPermissions: boolean;
  onSkipPermissionsChange: (value: boolean) => void;
  allowedTools: string[];
  onAllowedToolsChange: (value: string[]) => void;
  disallowedTools: string[];
  onDisallowedToolsChange: (value: string[]) => void;
};

function ClaudePermissions({
  skipPermissions,
  onSkipPermissionsChange,
  allowedTools,
  onAllowedToolsChange,
  disallowedTools,
  onDisallowedToolsChange,
}: Omit<ClaudePermissionsProps, 'agent'>) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-7">
      <SettingsSection title={t('tabs.permissions')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('permissions.defaultMode.label', { defaultValue: '默认权限' })}
            description={t('permissions.defaultMode.claudeDescription', {
              defaultValue: '默认情况下，Claude 可以读取工作区文件，并在执行命令或写入文件前请求您的批准。',
            })}
            onClick={() => onSkipPermissionsChange(false)}
          >
            <SettingsToggle
              checked={!skipPermissions}
              onChange={(checked) => onSkipPermissionsChange(!checked)}
              ariaLabel={t('permissions.defaultMode.label', { defaultValue: '默认权限' })}
            />
          </SettingsRow>

          <SettingsRow
            label={t('permissions.skipPermissions.label')}
            description={t('permissions.skipPermissions.claudeDescription')}
            onClick={() => onSkipPermissionsChange(!skipPermissions)}
          >
            <SettingsToggle
              checked={skipPermissions}
              onChange={onSkipPermissionsChange}
              ariaLabel={t('permissions.skipPermissions.label')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <RuleListEditor
        title={t('permissions.allowedTools.title')}
        description={t('permissions.allowedTools.description')}
        placeholder={t('permissions.allowedTools.placeholder')}
        emptyText={t('permissions.allowedTools.empty')}
        addLabel={t('permissions.actions.add')}
        items={allowedTools}
        onChange={onAllowedToolsChange}
        quickAddTitle={t('permissions.allowedTools.quickAdd')}
        quickAddItems={COMMON_CLAUDE_TOOLS}
      />

      <RuleListEditor
        title={t('permissions.blockedTools.title')}
        description={t('permissions.blockedTools.description')}
        placeholder={t('permissions.blockedTools.placeholder')}
        emptyText={t('permissions.blockedTools.empty')}
        addLabel={t('permissions.actions.add')}
        items={disallowedTools}
        onChange={onDisallowedToolsChange}
      />
    </div>
  );
}

type CursorPermissionsProps = {
  agent: 'cursor';
  skipPermissions: boolean;
  onSkipPermissionsChange: (value: boolean) => void;
  allowedCommands: string[];
  onAllowedCommandsChange: (value: string[]) => void;
  disallowedCommands: string[];
  onDisallowedCommandsChange: (value: string[]) => void;
};

function CursorPermissions({
  skipPermissions,
  onSkipPermissionsChange,
  allowedCommands,
  onAllowedCommandsChange,
  disallowedCommands,
  onDisallowedCommandsChange,
}: Omit<CursorPermissionsProps, 'agent'>) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-7">
      <SettingsSection title={t('tabs.permissions')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('permissions.defaultMode.label', { defaultValue: '默认权限' })}
            description={t('permissions.defaultMode.cursorDescription', {
              defaultValue: '默认情况下，Cursor 在执行未授权的 Shell 命令前会请求确认。',
            })}
            onClick={() => onSkipPermissionsChange(false)}
          >
            <SettingsToggle
              checked={!skipPermissions}
              onChange={(checked) => onSkipPermissionsChange(!checked)}
              ariaLabel={t('permissions.defaultMode.label', { defaultValue: '默认权限' })}
            />
          </SettingsRow>

          <SettingsRow
            label={t('permissions.skipPermissions.label')}
            description={t('permissions.skipPermissions.cursorDescription')}
            onClick={() => onSkipPermissionsChange(!skipPermissions)}
          >
            <SettingsToggle
              checked={skipPermissions}
              onChange={onSkipPermissionsChange}
              ariaLabel={t('permissions.skipPermissions.label')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <RuleListEditor
        title={t('permissions.allowedCommands.title')}
        description={t('permissions.allowedCommands.description')}
        placeholder={t('permissions.allowedCommands.placeholder')}
        emptyText={t('permissions.allowedCommands.empty')}
        addLabel={t('permissions.actions.add')}
        items={allowedCommands}
        onChange={onAllowedCommandsChange}
        quickAddTitle={t('permissions.allowedCommands.quickAdd')}
        quickAddItems={COMMON_CURSOR_COMMANDS}
      />

      <RuleListEditor
        title={t('permissions.blockedCommands.title')}
        description={t('permissions.blockedCommands.description')}
        placeholder={t('permissions.blockedCommands.placeholder')}
        emptyText={t('permissions.blockedCommands.empty')}
        addLabel={t('permissions.actions.add')}
        items={disallowedCommands}
        onChange={onDisallowedCommandsChange}
      />
    </div>
  );
}

type CodexPermissionsProps = {
  agent: 'codex';
  permissionMode: CodexPermissionMode;
  onPermissionModeChange: (value: CodexPermissionMode) => void;
};

const CODEX_MODES: CodexPermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions'];

function CodexPermissions({
  permissionMode,
  onPermissionModeChange,
}: Omit<CodexPermissionsProps, 'agent'>) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-5">
      <SettingsSection
        title={t('permissions.codex.permissionMode')}
        description={t('permissions.codex.description')}
      >
        <SettingsCard divided>
          {CODEX_MODES.map((mode) => (
            <SettingsRow
              key={mode}
              label={t(`permissions.codex.modes.${mode}.title`)}
              description={t(`permissions.codex.modes.${mode}.description`)}
              onClick={() => onPermissionModeChange(mode)}
            >
              <SettingsToggle
                checked={permissionMode === mode}
                onChange={() => onPermissionModeChange(mode)}
                ariaLabel={t(`permissions.codex.modes.${mode}.title`)}
              />
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>

      <details className="group rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground/80 hover:text-foreground">
          {t('permissions.codex.technicalDetails')}
        </summary>
        <div className="mt-2.5 space-y-1.5 leading-relaxed">
          {CODEX_MODES.map((mode) => (
            <p key={mode}>
              <strong className="text-foreground/90">{t(`permissions.codex.modes.${mode}.title`)}:</strong>{' '}
              {t(`permissions.codex.technicalInfo.${mode}`)}
            </p>
          ))}
          <p className="pt-1 opacity-75">{t('permissions.codex.technicalInfo.overrideNote')}</p>
        </div>
      </details>
    </div>
  );
}

type AntigravityPermissionsProps = {
  agent: 'antigravity';
  permissionMode: AntigravityPermissionMode;
  onPermissionModeChange: (value: AntigravityPermissionMode) => void;
};

const ANTIGRAVITY_MODES: AntigravityPermissionMode[] = [
  'default',
  'acceptEdits',
  'auto',
  'plan',
  'bypassPermissions',
];

function AntigravityPermissions({
  permissionMode,
  onPermissionModeChange,
}: Omit<AntigravityPermissionsProps, 'agent'>) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-5">
      <SettingsSection
        title={t('permissions.antigravity.permissionMode')}
        description={t('permissions.antigravity.description')}
      >
        <SettingsCard divided>
          {ANTIGRAVITY_MODES.map((mode) => (
            <SettingsRow
              key={mode}
              label={t(`permissions.antigravity.modes.${mode}.title`)}
              description={t(`permissions.antigravity.modes.${mode}.description`)}
              onClick={() => onPermissionModeChange(mode)}
            >
              <SettingsToggle
                checked={permissionMode === mode}
                onChange={() => onPermissionModeChange(mode)}
                ariaLabel={t(`permissions.antigravity.modes.${mode}.title`)}
              />
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>

      <details className="group rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground/80 hover:text-foreground">
          {t('permissions.antigravity.technicalDetails')}
        </summary>
        <div className="mt-2.5 space-y-1.5 leading-relaxed">
          {ANTIGRAVITY_MODES.map((mode) => (
            <p key={mode}>
              <strong className="text-foreground/90">{t(`permissions.antigravity.modes.${mode}.title`)}:</strong>{' '}
              {t(`permissions.antigravity.technicalInfo.${mode}`)}
            </p>
          ))}
          <p className="pt-1 opacity-75">{t('permissions.antigravity.technicalInfo.overrideNote')}</p>
        </div>
      </details>
    </div>
  );
}

type PermissionsContentProps =
  | ClaudePermissionsProps
  | CursorPermissionsProps
  | CodexPermissionsProps
  | AntigravityPermissionsProps;

export default function PermissionsContent(props: PermissionsContentProps) {
  if (props.agent === 'claude') {
    return <ClaudePermissions {...props} />;
  }

  if (props.agent === 'cursor') {
    return <CursorPermissions {...props} />;
  }

  if (props.agent === 'antigravity') {
    return <AntigravityPermissions {...props} />;
  }

  return <CodexPermissions {...props} />;
}
