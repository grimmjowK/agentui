import { useTranslation } from 'react-i18next';
import { cn } from '../../../../../../lib/utils';
import type { AgentCategory } from '../../../../types/types';
import type { AgentCategoryTabsSectionProps } from '../types';

const AGENT_CATEGORIES: AgentCategory[] = ['account', 'permissions', 'mcp', 'skills'];

export default function AgentCategoryTabsSection({
  selectedCategory,
  onSelectCategory,
}: AgentCategoryTabsSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <div role="tablist" className="flex flex-wrap gap-1.5">
      {AGENT_CATEGORIES.map((category) => {
        const isActive = selectedCategory === category;
        return (
          <button
            key={category}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelectCategory(category)}
            className={cn(
              'rounded-xl px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-150',
              isActive
                ? 'bg-foreground text-background dark:bg-foreground dark:text-background'
                : 'bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground',
            )}
          >
            {category === 'account' && t('tabs.account')}
            {category === 'permissions' && t('tabs.permissions')}
            {category === 'mcp' && t('tabs.mcpServers')}
            {category === 'skills' && t('tabs.skills')}
          </button>
        );
      })}
    </div>
  );
}
