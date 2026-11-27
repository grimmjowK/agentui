import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ProviderLoginModal from '../../provider-auth/view/ProviderLoginModal';
import SettingsSidebar from '../view/SettingsSidebar';
import AgentsSettingsTab from '../view/tabs/agents-settings/AgentsSettingsTab';
import AppearanceSettingsTab from '../view/tabs/AppearanceSettingsTab';
import CredentialsSettingsTab from '../view/tabs/api-settings/CredentialsSettingsTab';
import GitSettingsTab from '../view/tabs/git-settings/GitSettingsTab';
import NotificationsSettingsTab from '../view/tabs/NotificationsSettingsTab';
import TasksSettingsTab from '../view/tabs/tasks-settings/TasksSettingsTab';
import PluginSettingsTab from '../../plugins/view/PluginSettingsTab';
import AboutTab from '../view/tabs/AboutTab';
import { useSettingsController } from '../hooks/useSettingsController';
import { useWebPush } from '../../../hooks/useWebPush';
import type { SettingsMainTab, SettingsProps } from '../types/types';

const TAB_TITLE_KEYS: Record<SettingsMainTab, string> = {
  agents: 'mainTabs.agents',
  appearance: 'mainTabs.appearance',
  git: 'mainTabs.git',
  api: 'mainTabs.apiTokens',
  tasks: 'mainTabs.tasks',
  plugins: 'mainTabs.plugins',
  notifications: 'mainTabs.notifications',
  about: 'mainTabs.about',
};

function Settings({ isOpen, onClose, projects = [], initialTab = 'agents' }: SettingsProps) {
  const { t } = useTranslation('settings');
  const {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    notificationPreferences,
    setNotificationPreferences,
    cursorPermissions,
    setCursorPermissions,
    antigravityPermissions,
    setAntigravityPermissions,
    codexPermissionMode,
    setCodexPermissionMode,
    providerAuthStatus,
    openLoginForProvider,
    openInstallForProvider,
    closeLoginModal,
    showLoginModal,
    loginProvider,
    handleLoginComplete,
  } = useSettingsController({
    isOpen,
    initialTab,
  });

  const {
    permission: pushPermission,
    isSubscribed: isPushSubscribed,
    isLoading: isPushLoading,
    subscribe: pushSubscribe,
    unsubscribe: pushUnsubscribe,
  } = useWebPush();

  const handleEnablePush = async () => {
    await pushSubscribe();
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: true },
    });
  };

  const handleDisablePush = async () => {
    await pushUnsubscribe();
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: false },
    });
  };

  if (!isOpen) {
    return null;
  }

  const isAuthenticated = Boolean(loginProvider && providerAuthStatus[loginProvider].authenticated);

  return (
    <div className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm md:p-6">
      <div className="relative flex h-full w-full flex-col overflow-hidden border border-border/70 bg-background shadow-2xl md:h-[86vh] md:max-w-5xl md:flex-row md:rounded-2xl">
        {/* Mobile header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border/60 px-4 py-3 md:hidden">
          <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <SettingsSidebar activeTab={activeTab} onChange={setActiveTab} />

        {/* Content */}
        <main className="relative flex-1 overflow-y-auto bg-background">
          {/* Desktop floating top-right status & close */}
          <div className="sticky top-0 z-20 hidden items-center justify-end gap-2 px-6 pt-4 md:flex">
            {saveStatus === 'success' && (
              <span className="animate-in fade-in inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <Check className="h-3 w-3" />
                {t('saveStatus.success')}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-muted/40 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div
            key={activeTab}
            className="settings-content-enter mx-auto w-full max-w-2xl px-4 pb-12 pt-4 md:px-8 md:pt-2"
          >
            <h1 className="mb-6 text-2xl font-semibold tracking-tight text-foreground">
              {t(TAB_TITLE_KEYS[activeTab])}
            </h1>

            <div className="space-y-8">
              {activeTab === 'appearance' && (
                <AppearanceSettingsTab
                  projectSortOrder={projectSortOrder}
                  onProjectSortOrderChange={setProjectSortOrder}
                  codeEditorSettings={codeEditorSettings}
                  onCodeEditorThemeChange={(value) => updateCodeEditorSetting('theme', value)}
                  onCodeEditorWordWrapChange={(value) => updateCodeEditorSetting('wordWrap', value)}
                  onCodeEditorShowMinimapChange={(value) => updateCodeEditorSetting('showMinimap', value)}
                  onCodeEditorLineNumbersChange={(value) => updateCodeEditorSetting('lineNumbers', value)}
                  onCodeEditorFontSizeChange={(value) => updateCodeEditorSetting('fontSize', value)}
                />
              )}

              {activeTab === 'git' && <GitSettingsTab />}

              {activeTab === 'agents' && (
                <AgentsSettingsTab
                  providerAuthStatus={providerAuthStatus}
                  onProviderLogin={openLoginForProvider}
                  onProviderInstall={openInstallForProvider}
                  claudePermissions={claudePermissions}
                  onClaudePermissionsChange={setClaudePermissions}
                  cursorPermissions={cursorPermissions}
                  onCursorPermissionsChange={setCursorPermissions}
                  antigravityPermissions={antigravityPermissions}
                  onAntigravityPermissionsChange={setAntigravityPermissions}
                  codexPermissionMode={codexPermissionMode}
                  onCodexPermissionModeChange={setCodexPermissionMode}
                  projects={projects}
                />
              )}

              {activeTab === 'tasks' && <TasksSettingsTab />}

              {activeTab === 'notifications' && (
                <NotificationsSettingsTab
                  notificationPreferences={notificationPreferences}
                  onNotificationPreferencesChange={setNotificationPreferences}
                  pushPermission={pushPermission}
                  isPushSubscribed={isPushSubscribed}
                  isPushLoading={isPushLoading}
                  onEnablePush={handleEnablePush}
                  onDisablePush={handleDisablePush}
                />
              )}

              {activeTab === 'api' && <CredentialsSettingsTab />}

              {activeTab === 'plugins' && <PluginSettingsTab />}

              {activeTab === 'about' && <AboutTab />}
            </div>
          </div>
        </main>
      </div>

      <ProviderLoginModal
        key={loginProvider || 'claude'}
        isOpen={showLoginModal}
        onClose={closeLoginModal}
        provider={loginProvider || 'claude'}
        onComplete={handleLoginComplete}
        isAuthenticated={isAuthenticated}
      />
    </div>
  );
}

export default Settings;
