import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IS_DESKTOP } from '../../../../constants/config';
import type { NotificationPreferencesState } from '../../types/types';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

type NotificationsSettingsTabProps = {
  notificationPreferences: NotificationPreferencesState;
  onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
  pushPermission: NotificationPermission | 'unsupported';
  isPushSubscribed: boolean;
  isPushLoading: boolean;
  onEnablePush: () => void;
  onDisablePush: () => void;
};

export default function NotificationsSettingsTab({
  notificationPreferences,
  onNotificationPreferencesChange,
  pushPermission,
  isPushSubscribed,
  isPushLoading,
  onEnablePush,
  onDisablePush,
}: NotificationsSettingsTabProps) {
  const { t } = useTranslation('settings');

  // Electron 没有推送服务，Web Push 订阅必然失败；桌面端靠外壳的 Dock 角标 / 跳动提醒
  if (IS_DESKTOP) {
    return (
      <div className="space-y-6">
        <SettingsSection title={t('notifications.title')}>
          <SettingsCard>
            <div className="px-5 py-4 text-[13px] leading-relaxed text-muted-foreground">
              {t('notifications.desktopNote')}
            </div>
          </SettingsCard>
        </SettingsSection>
      </div>
    );
  }

  const pushSupported = pushPermission !== 'unsupported';
  const pushDenied = pushPermission === 'denied';

  const setEventFlag = (key: keyof NotificationPreferencesState['events'], value: boolean) => {
    onNotificationPreferencesChange({
      ...notificationPreferences,
      events: {
        ...notificationPreferences.events,
        [key]: value,
      },
    });
  };

  return (
    <div className="space-y-7">
      <SettingsSection
        title={t('notifications.webPush.title')}
        description={t('notifications.description')}
      >
        <SettingsCard>
          <SettingsRow
            label={t('notifications.webPush.title')}
            description={
              !pushSupported
                ? t('notifications.webPush.unsupported')
                : pushDenied
                  ? t('notifications.webPush.denied')
                  : isPushSubscribed
                    ? t('notifications.webPush.enabled')
                    : t('notifications.description')
            }
          >
            {pushSupported && !pushDenied && (
              <div className="flex items-center gap-2">
                {isPushLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                <SettingsToggle
                  checked={isPushSubscribed}
                  disabled={isPushLoading}
                  onChange={() => {
                    if (isPushSubscribed) onDisablePush();
                    else onEnablePush();
                  }}
                  ariaLabel={t('notifications.webPush.title')}
                />
              </div>
            )}
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('notifications.events.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('notifications.events.actionRequired')}
            onClick={() => setEventFlag('actionRequired', !notificationPreferences.events.actionRequired)}
          >
            <SettingsToggle
              checked={notificationPreferences.events.actionRequired}
              onChange={(checked) => setEventFlag('actionRequired', checked)}
              ariaLabel={t('notifications.events.actionRequired')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('notifications.events.stop')}
            onClick={() => setEventFlag('stop', !notificationPreferences.events.stop)}
          >
            <SettingsToggle
              checked={notificationPreferences.events.stop}
              onChange={(checked) => setEventFlag('stop', checked)}
              ariaLabel={t('notifications.events.stop')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('notifications.events.error')}
            onClick={() => setEventFlag('error', !notificationPreferences.events.error)}
          >
            <SettingsToggle
              checked={notificationPreferences.events.error}
              onChange={(checked) => setEventFlag('error', checked)}
              ariaLabel={t('notifications.events.error')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
