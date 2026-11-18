import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, MessagesSquare, MoreHorizontal, Pencil, Plus, Trash2, Workflow, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { useMultiAgents } from '../hooks/useMultiAgents';
import type { MultiAgent, MultiAgentKind } from '../types/types';
import { compactAge } from '../utils/relativeTime';

type MultiAgentListProps = {
  searchFilter: string;
  activeId: string | null;
  /** 建立時綁定的專案（目前選中的專案），沒有則用專屬目錄 */
  projectId: string | null;
  onOpen: (id: string) => void;
};

const KIND_ICON = { chatroom: MessagesSquare, workflow: Workflow } as const;

/** 側邊欄「多 Agent」模式：列表 + 底部建立按鈕（multi-agent-sidebar spec） */
export default function MultiAgentList({ searchFilter, activeId, projectId, onOpen }: MultiAgentListProps) {
  const { t } = useTranslation('multiAgent');
  const { items, loaded, create, rename, remove } = useMultiAgents();
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const query = searchFilter.trim().toLowerCase();
  const filtered = useMemo(
    () => (query ? items.filter((item) => item.name.toLowerCase().includes(query)) : items),
    [items, query],
  );

  const handleCreate = async (kind: MultiAgentKind) => {
    setShowCreate(false);
    setCreating(true);
    try {
      const agent = await create(kind, projectId);
      onOpen(agent.id);
    } catch (error) {
      console.error('[multi-agent] create failed', error);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 py-1">
        {!loaded ? null : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center md:py-8">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
              <Bot className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="mb-1 text-sm font-medium text-foreground">
              {items.length === 0 ? t('list.empty') : t('list.noMatch')}
            </h3>
            {items.length === 0 && <p className="text-xs leading-relaxed text-muted-foreground">{t('list.emptyHint')}</p>}
          </div>
        ) : (
          filtered.map((item) => (
            <MultiAgentRow
              key={item.id}
              item={item}
              active={item.id === activeId}
              onOpen={() => onOpen(item.id)}
              onRename={(name) => rename(item.id, name)}
              onDelete={() => remove(item.id)}
            />
          ))
        )}
      </div>

      <div className="relative flex-shrink-0 px-2 pb-2 pt-1">
        {showCreate && (
          <CreateMenu onPick={(kind) => void handleCreate(kind)} onClose={() => setShowCreate(false)} />
        )}
        <button
          type="button"
          disabled={creating}
          onClick={() => setShowCreate((open) => !open)}
          aria-expanded={showCreate}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/80 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('list.create')}
        </button>
      </div>
    </div>
  );
}

function CreateMenu({ onPick, onClose }: { onPick: (kind: MultiAgentKind) => void; onClose: () => void }) {
  const { t } = useTranslation('multiAgent');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="absolute bottom-full left-2 right-2 mb-1 space-y-1 rounded-xl border border-border/60 bg-popover p-1.5 shadow-lg"
    >
      {(['chatroom', 'workflow'] as const).map((kind) => {
        const Icon = KIND_ICON[kind];
        return (
          <button
            key={kind}
            type="button"
            role="menuitem"
            onClick={() => onPick(kind)}
            className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent"
          >
            <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">{t(`kind.${kind}`)}</span>
              <span className="block text-xs text-muted-foreground">{t(`kind.${kind}Desc`)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

type RowProps = {
  item: MultiAgent;
  active: boolean;
  onOpen: () => void;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
};

function MultiAgentRow({ item, active, onOpen, onRename, onDelete }: RowProps) {
  const { t } = useTranslation('multiAgent');
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(item.name);
  const Icon = KIND_ICON[item.kind];

  const submitRename = async () => {
    const next = name.trim();
    setEditing(false);
    if (next && next !== item.name) await onRename(next).catch(() => setName(item.name));
    else setName(item.name);
  };

  if (confirmDelete) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
        <p className="mb-2 text-xs text-foreground">{t('list.deleteConfirm', { name: item.name })}</p>
        <div className="flex justify-end gap-1.5">
          <button type="button" className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent" onClick={() => setConfirmDelete(false)}>
            {t('list.cancel')}
          </button>
          <button
            type="button"
            className="rounded-md bg-destructive px-2 py-1 text-xs text-destructive-foreground hover:bg-destructive/90"
            onClick={() => { setConfirmDelete(false); void onDelete(); }}
          >
            {t('list.delete')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors',
        active ? 'bg-accent text-foreground' : 'hover:bg-accent/50',
      )}
    >
      <span className={cn(
        'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg',
        item.kind === 'workflow' ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400' : 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
      )}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitRename();
              if (event.key === 'Escape') { setName(item.name); setEditing(false); }
            }}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button type="button" onClick={() => void submitRename()} className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label={t('list.rename')}>
            <Check className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => { setName(item.name); setEditing(false); }} className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label={t('list.cancel')}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{item.name}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {t(`kind.${item.kind}`)}
              {!item.definition && ` · ${t('page.draft')}`}
            </span>
          </span>
          <span className="hidden flex-shrink-0 text-[10px] text-muted-foreground/70 md:inline md:group-hover:hidden">{compactAge(item.updatedAt)}</span>
        </button>
      )}
      {!editing && (
        <div className="relative flex-shrink-0 md:hidden md:group-hover:block">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className="rounded-md p-1 text-muted-foreground hover:bg-background/80 hover:text-foreground"
            aria-label={t('list.more')}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-full z-20 mt-1 w-32 rounded-lg border border-border/60 bg-popover p-1 shadow-lg"
              onMouseLeave={() => setMenuOpen(false)}
            >
              <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent" onClick={() => { setMenuOpen(false); setEditing(true); }}>
                <Pencil className="h-3 w-3" />{t('list.rename')}
              </button>
              <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10" onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}>
                <Trash2 className="h-3 w-3" />{t('list.delete')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
