import { cn } from '../../../../../../lib/utils';
import SessionProviderLogo from '../../../../../llm-logo-provider/SessionProviderLogo';
import type { AgentProvider } from '../../../../types/types';
import type { AgentSelectorSectionProps } from '../types';

const AGENT_NAMES: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export default function AgentSelectorSection({
  agents,
  selectedAgent,
  onSelectAgent,
  agentContextById,
}: AgentSelectorSectionProps) {
  return (
    <div className="inline-flex w-full flex-wrap gap-1 rounded-2xl bg-foreground/[0.04] p-1 dark:bg-white/[0.05]">
      {agents.map((agent) => {
        const isActive = selectedAgent === agent;
        const isAuth = agentContextById[agent].authStatus.authenticated;

        return (
          <button
            key={agent}
            type="button"
            onClick={() => onSelectAgent(agent)}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-[13px] font-medium transition-all duration-150',
              isActive
                ? 'bg-background text-foreground shadow-sm dark:bg-card'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <SessionProviderLogo provider={agent} className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">{AGENT_NAMES[agent]}</span>
            <span
              className={cn(
                'h-1.5 w-1.5 flex-shrink-0 rounded-full',
                isAuth ? 'bg-emerald-500' : 'bg-muted-foreground/30',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
