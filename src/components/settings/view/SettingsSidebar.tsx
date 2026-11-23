import { useMemo, useState } from 'react';
import { Bell, Bot, GitBranch, Info, Key, ListChecks, Palette, Puzzle, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { PillBar, Pill } from '../../../shared/view/ui';
import type { SettingsMainTab } from '../types/types';

type SettingsSidebarProps = {
  activeTab: SettingsMainTab;
  onChange: (tab: SettingsMainTab) => void;
};

type NavItem = {
  id: SettingsMainTab;
  labelKey: string;
  icon: typeof Bot;
};

type NavGroup = {
  groupKey: string;
  defaultLabel: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    groupKey: 'navGroups.general',
    defaultLabel: '常规',
    items: [
      { id: 'appearance', labelKey: 'mainTabs.appearance', icon: Palette },
      { id: 'notifications', labelKey: 'mainTabs.notifications', icon: Bell },
    ],
  },
  {
    groupKey: 'navGroups.coding',
    defaultLabel: '编码',
    items: [
      { id: 'agents', labelKey: 'mainTabs.agents', icon: Bot },
      { id: 'git', labelKey: 'mainTabs.git', icon: GitBranch },
      { id: 'tasks', labelKey: 'mainTabs.tasks', icon: ListChecks },
    ],
  },
  {
    groupKey: 'navGroups.integrations',
    defaultLabel: '集成',
    items: [
      { id: 'plugins', labelKey: 'mainTabs.plugins', icon: Puzzle },
      { id: 'api', labelKey: 'mainTabs.apiTokens', icon: Key },
      { id: 'about', labelKey: 'mainTabs.about', icon: Info },
    ],
  },
];

const ALL_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

export default function SettingsSidebar({ activeTab, onChange }: SettingsSidebarProps) {
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NAV_GROUPS;
    return NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => t(item.labelKey).toLowerCase().includes(q)),
    })).filter((group) => group.items.length > 0);
  }, [query, t]);

  return (
    <>
      {/* Desktop sidebar — Codex style */}
      <aside className="hidden w-60 flex-shrink-0 border-r border-border/60 bg-muted/25 dark:bg-muted/10 md:flex md:flex-col">
        <div className="px-4 pb-2 pt-5">
          <h2 className="px-1.5 text-[17px] font-semibold tracking-tight text-foreground">
            {t('title')}
          </h2>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('searchPlaceholder', { defaultValue: '搜索' })}
              className="h-8 w-full rounded-xl bg-foreground/[0.05] pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground/70 focus:bg-foreground/[0.08] focus:outline-none dark:bg-white/[0.06] dark:focus:bg-white/[0.1]"
            />
          </div>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
          {filteredGroups.map((group) => (
            <div key={group.groupKey} className="space-y-0.5">
              <div className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground/70">
                {t(group.groupKey, { defaultValue: group.defaultLabel })}
              </div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onChange(item.id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13.5px] transition-colors duration-150',
                      isActive
                        ? 'bg-foreground/[0.07] font-medium text-foreground dark:bg-white/[0.1]'
                        : 'text-foreground/75 hover:bg-foreground/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]',
                    )}
                  >
                    <Icon className="h-4 w-4 flex-shrink-0 opacity-80" />
                    <span className="truncate">{t(item.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* Mobile horizontal nav — pill bar */}
      <div className="flex-shrink-0 border-b border-border/60 px-3 py-2 md:hidden">
        <PillBar className="scrollbar-hide w-full overflow-x-auto">
          {ALL_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Pill
                key={item.id}
                isActive={activeTab === item.id}
                onClick={() => onChange(item.id)}
                className="flex-shrink-0"
              >
                <Icon className="h-3.5 w-3.5" />
                {t(item.labelKey)}
              </Pill>
            );
          })}
        </PillBar>
      </div>
    </>
  );
}
