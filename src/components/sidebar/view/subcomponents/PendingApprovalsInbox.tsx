import { ShieldAlert } from 'lucide-react';
import type { TFunction } from 'i18next';

import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { LLMProvider } from '../../../../types/app';

export type PendingInboxItem = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  label: string;
  count: number;
};

type PendingApprovalsInboxProps = {
  items: PendingInboxItem[];
  onOpen: (item: PendingInboxItem) => void;
  t: TFunction;
};

/** 側邊欄頂部的待審批收件匣：列出所有等待審批的會話，點擊跳轉。沒有項目時不顯示。 */
export default function PendingApprovalsInbox({ items, onOpen, t }: PendingApprovalsInboxProps) {
  if (items.length === 0) return null;
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return (
    <div className="mx-2 mt-2 rounded-lg border border-amber-300/60 bg-amber-50/70 p-2 dark:border-amber-700/50 dark:bg-amber-900/20">
      <div className="mb-1 flex items-center gap-1.5 px-1 text-xs font-medium text-amber-800 dark:text-amber-300">
        <ShieldAlert className="h-3.5 w-3.5" />
        {t('pendingApprovals.inbox', { count: total })}
      </div>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.sessionId}>
            <button
              type="button"
              onClick={() => onOpen(item)}
              className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-amber-100/80 dark:hover:bg-amber-900/40"
            >
              <SessionProviderLogo provider={item.provider as LLMProvider} className="h-3 w-3 flex-shrink-0" />
              <span className="min-w-0 flex-1 truncate text-foreground">{item.label}</span>
              {item.count > 1 && <span className="text-[10px] text-amber-700 dark:text-amber-400">{item.count}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
