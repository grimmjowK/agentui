/**
 * 聊天室頁面：群聊訊息 + @ 候選輸入框 + 右側成員與群聊設定（multi-agent-chatroom spec）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Archive, ArrowUp, ChevronDown, Clock, History, PanelRightClose, Plus, RotateCcw, Square, Trash2, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  EVERYONE_NAME,
  MAX_AI_REPLIES_RANGE,
  MEMBER_DEFAULT_PERMISSION_MODE,
} from '../../../../../shared/multiAgent';
import { Markdown } from '../../../chat/view/subcomponents/Markdown';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { cn } from '../../../../lib/utils';
import { api } from '../../../../utils/api';
import { useChatroom } from '../../hooks/useChatroom';
import { upsertMultiAgentLocal } from '../../hooks/useMultiAgents';
import { modelLabel, useProviderModels, type ModelsByProvider } from '../../hooks/useProviderModels';
import type { ChatMember, ChatMessage, ChatroomDef, ChatRules, ChatThread, MultiAgent } from '../../types/types';
import { readData } from '../../utils/fetchJson';
import { initialOf, memberColorClass } from '../../utils/memberColor';

import ModelPicker from './ModelPicker';
import { PermissionSelect } from './WorkflowView';

type ChatroomViewProps = {
  agent: MultiAgent;
  isMobile: boolean;
  onAgentChange: (agent: MultiAgent) => void;
};

export default function ChatroomView({ agent, isMobile, onAgentChange }: ChatroomViewProps) {
  const { t } = useTranslation('multiAgent');
  const def = agent.definition as ChatroomDef;
  const models = useProviderModels();
  const chat = useChatroom(agent.id);
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);

  const saveDefinition = useCallback(async (definition: ChatroomDef) => {
    const saved = await readData<MultiAgent>(api.multiAgent.saveDefinition(agent.id, definition));
    upsertMultiAgentLocal(saved);
    onAgentChange(saved);
  }, [agent.id, onAgentChange]);

  const visibleThreads = useMemo(() => chat.threads.filter((th) => !th.isArchived), [chat.threads]);
  const currentThread = chat.threads.find((th) => th.id === chat.selectedThreadId) ?? visibleThreads[0] ?? null;

  // 頂部標籤列：顯示所有正在發言中的未歸檔對話 + 當前選中的對話
  const pillThreads = useMemo(() => {
    const activeList = visibleThreads.filter((th) => Boolean(chat.activeTurns[th.id]));
    if (currentThread && !activeList.some((th) => th.id === currentThread.id)) {
      activeList.unshift(currentThread);
    }
    return activeList;
  }, [visibleThreads, chat.activeTurns, currentThread]);

  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 頂部工具列：多對話切換、對話記錄與「+ 新對話」 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
            {pillThreads.length <= 1 && visibleThreads.length <= 1 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className={cn(
                  'h-2 w-2 flex-shrink-0 rounded-full',
                  chat.activeTurnId ? 'animate-pulse bg-primary' : 'bg-emerald-500',
                )} />
                <span className="truncate font-medium text-foreground/85">
                  {currentThread?.title || t('chatroom.newChat', { defaultValue: '新对话' })}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                {(pillThreads.length > 1 ? pillThreads : visibleThreads.slice(0, 4)).map((item) => {
                  const selectedPill = item.id === chat.selectedThreadId;
                  const itemBusy = Boolean(chat.activeTurns[item.id]);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => chat.selectThread(item.id)}
                      title={item.title}
                      className={cn(
                        'flex max-w-[180px] items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                        selectedPill
                          ? 'border-primary/50 bg-primary/10 text-foreground'
                          : 'border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <span className={cn(
                        'h-2 w-2 flex-shrink-0 rounded-full',
                        itemBusy ? 'animate-pulse bg-primary' : 'bg-emerald-500',
                      )} />
                      <span className="truncate">{item.title}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex flex-shrink-0 items-center gap-2">
            <ThreadHistory
              threads={chat.threads}
              currentId={chat.selectedThreadId}
              activeTurns={chat.activeTurns}
              onSelect={chat.selectThread}
              onArchive={(threadId) => void chat.deleteThread(threadId, { force: false })}
              onRestore={(threadId) => void chat.restoreThread(threadId)}
              onDeletePermanent={(threadId) => void chat.deleteThread(threadId, { force: true })}
            />
            <button
              type="button"
              onClick={() => void chat.createThread()}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('chatroom.newChat', { defaultValue: '新对话' })}
            </button>
            {!sidebarOpen && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="flex h-7 items-center gap-1 rounded-lg border border-border/70 px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t('chatroom.expand')}
              >
                <Users className="h-3.5 w-3.5" />{def.members.length}
              </button>
            )}
          </div>
        </div>

        <MessageList
          messages={chat.messages}
          members={def.members}
          models={models}
          loading={chat.loading}
          hasMore={chat.hasMore}
          onLoadEarlier={chat.loadEarlier}
          onCancelQueued={chat.cancelQueued}
        />
        {chat.error && (
          <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span className="flex-1">{chat.error}</span>
            <button type="button" onClick={chat.clearError} aria-label="close"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}
        <Composer
          members={def.members}
          busy={Boolean(chat.activeTurnId)}
          onSend={chat.send}
          onStop={chat.stop}
        />
      </div>

      {sidebarOpen && (
        <ChatroomSidebar
          def={def}
          models={models}
          onSave={saveDefinition}
          onClose={() => setSidebarOpen(false)}
        />
      )}
    </div>
  );
}

function ThreadHistory({
  threads,
  currentId,
  activeTurns,
  onSelect,
  onArchive,
  onRestore,
  onDeletePermanent,
}: {
  threads: ChatThread[];
  currentId: string;
  activeTurns: Record<string, string | null>;
  onSelect: (threadId: string) => void;
  onArchive: (threadId: string) => void;
  onRestore: (threadId: string) => void;
  onDeletePermanent: (threadId: string) => void;
}) {
  const { t, i18n } = useTranslation('multiAgent');
  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const activeList = threads.filter((th) => !th.isArchived);
  const archivedList = threads.filter((th) => th.isArchived);
  const displayed = showArchived ? archivedList : activeList;

  const format = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <History className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t('chatroom.history', { defaultValue: '对话记录' })}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-72 rounded-xl border border-border/60 bg-popover p-1.5 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="mb-1 flex items-center gap-1 rounded-lg bg-muted/50 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setShowArchived(false)}
              className={cn(
                'flex-1 rounded-md py-1 font-medium transition-colors',
                !showArchived ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t('historyMenu.active', { defaultValue: '活跃' })} ({activeList.length})
            </button>
            <button
              type="button"
              onClick={() => setShowArchived(true)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1 rounded-md py-1 font-medium transition-colors',
                showArchived ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Archive className="h-3 w-3" />
              {t('historyMenu.archived', { defaultValue: '已归档' })} ({archivedList.length})
            </button>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {displayed.length === 0 && (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                {showArchived
                  ? t('historyMenu.emptyArchived', { defaultValue: '暂无归档记录' })
                  : t('chatroom.empty')}
              </div>
            )}
            {displayed.map((item) => {
              const busy = Boolean(activeTurns[item.id]);
              return (
                <div
                  key={item.id}
                  className={cn(
                    'group flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-xs hover:bg-accent',
                    currentId === item.id && 'bg-accent/60 font-medium',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => { onSelect(item.id); setOpen(false); }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className={cn(
                      'h-1.5 w-1.5 flex-shrink-0 rounded-full',
                      busy ? 'animate-pulse bg-primary' : 'bg-emerald-500',
                    )} />
                    <span className="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
                    <span className="flex-shrink-0 text-muted-foreground">{format(item.updatedAt)}</span>
                  </button>
                  {showArchived ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRestore(item.id);
                      }}
                      title={t('historyMenu.restore', { defaultValue: '还原' })}
                      className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onArchive(item.id);
                      }}
                      title={t('historyMenu.archive', { defaultValue: '归档' })}
                      className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                    >
                      <Archive className="h-3 w-3" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeletePermanent(item.id);
                    }}
                    title={t('historyMenu.deletePermanent', { defaultValue: '永久删除' })}
                    className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------- 訊息列表 -----------------

function MessageList({ messages, members, models, loading, hasMore, onLoadEarlier, onCancelQueued }: {
  messages: ChatMessage[];
  members: ChatMember[];
  models: ModelsByProvider;
  loading: boolean;
  hasMore: boolean;
  onLoadEarlier: () => Promise<void>;
  onCancelQueued: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation('multiAgent');
  const ref = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const last = messages.at(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.content]);

  return (
    <div
      ref={ref}
      onScroll={() => {
        const el = ref.current!;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
        {hasMore && (
          <div className="text-center">
            <button type="button" onClick={() => void onLoadEarlier()} className="rounded-full px-3 py-1 text-xs text-muted-foreground hover:bg-accent">
              {t('chatroom.loadEarlier')}
            </button>
          </div>
        )}
        {!loading && messages.length === 0 && (
          <div className="flex flex-col items-center py-16 text-center">
            <div className="mb-4 flex -space-x-2">
              {members.slice(0, 5).map((m) => (
                <span key={m.id} className={cn('flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ring-2 ring-background', memberColorClass(m.id))}>
                  {initialOf(m.name)}
                </span>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">{t('chatroom.empty')}</p>
          </div>
        )}
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} models={models} onCancelQueued={onCancelQueued} />
        ))}
      </div>
    </div>
  );
}

const FINISH_LABEL: Record<string, string> = {
  length: 'chatroom.truncated',
  timeout: 'chatroom.timeout',
  stopped: 'chatroom.stoppedReply',
  error: 'chatroom.error',
  interrupted: 'workflow.interrupted',
};

function MessageBubble({ message, models, onCancelQueued }: {
  message: ChatMessage;
  models: ModelsByProvider;
  onCancelQueued: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation('multiAgent');

  if (message.authorKind === 'system') {
    return <div className="text-center text-xs text-muted-foreground">— {message.content} —</div>;
  }

  if (message.authorKind === 'user') {
    const queued = message.status === 'queued';
    return (
      <div className="flex flex-col items-end">
        <div className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground',
          queued && 'opacity-60',
        )}>
          {message.content}
        </div>
        {queued && (
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />{t('chatroom.queued')}
            <button type="button" onClick={() => void onCancelQueued(message.id)} className="underline-offset-2 hover:underline">
              {t('chatroom.cancelQueued')}
            </button>
          </div>
        )}
      </div>
    );
  }

  const author = message.author ?? { name: '?' };
  const streaming = message.status === 'streaming';
  const finishKey = message.finishReason ? FINISH_LABEL[message.finishReason] : null;
  return (
    <div className="flex items-start gap-2.5">
      <span className={cn('mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-semibold', memberColorClass(message.memberId ?? author.name))}>
        {initialOf(author.name)}
      </span>
      <div className="min-w-0 max-w-[85%]">
        <div className="mb-1 flex items-center gap-1.5 text-xs">
          <span className="font-medium text-foreground">{author.name}</span>
          {author.provider && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <SessionProviderLogo provider={author.provider} className="h-2.5 w-2.5" />
              {author.model ? modelLabel(models, author.provider, author.model) : null}
            </span>
          )}
        </div>
        <div className={cn(
          'rounded-2xl rounded-tl-md border border-border/60 bg-card px-3.5 py-2 text-sm',
          message.status === 'error' && 'border-destructive/30 bg-destructive/5',
        )}>
          {message.content ? (
            <Markdown className="prose prose-sm max-w-none dark:prose-invert">{message.content}</Markdown>
          ) : streaming ? (
            <span className="inline-flex gap-1 py-1">
              {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60" style={{ animationDelay: `${i * 120}ms` }} />)}
            </span>
          ) : null}
        </div>
        {finishKey && <div className="mt-1 text-[11px] text-muted-foreground">{t(finishKey)}</div>}
      </div>
    </div>
  );
}

// ----------------- 輸入框 -----------------

function Composer({ members, busy, onSend, onStop, trailing }: {
  members: ChatMember[];
  busy: boolean;
  onSend: (content: string) => Promise<void>;
  onStop: () => Promise<void>;
  trailing?: React.ReactNode;
}) {
  const { t } = useTranslation('multiAgent');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const all = [{ id: '__all__', name: EVERYONE_NAME }, ...members];
    const q = mention.query.toLowerCase();
    return all.filter((m) => m.name.toLowerCase().includes(q));
  }, [mention, members]);

  useEffect(() => setHighlight(0), [mention?.query]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const updateMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const match = /(^|\s)@([^\s@]*)$/.exec(before);
    setMention(match ? { start: caret - match[2].length - 1, query: match[2] } : null);
  };

  const pick = (name: string) => {
    if (!mention) return;
    const caret = ref.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = mention.start + name.length + 2;
      ref.current?.setSelectionRange(pos, pos);
      ref.current?.focus();
    });
  };

  const submit = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await onSend(content);
      setText('');
    } catch {
      // 錯誤由上層顯示，保留輸入
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex-shrink-0 px-4 pb-4" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
      <div className="relative mx-auto w-full max-w-3xl">
        {mention && candidates.length > 0 && (
          <div className="absolute bottom-full left-0 mb-2 w-56 overflow-hidden rounded-xl border border-border/60 bg-popover p-1 shadow-lg" role="listbox">
            {candidates.map((c, i) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => { e.preventDefault(); pick(c.name); }}
                className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm', i === highlight ? 'bg-accent' : 'hover:bg-accent/60')}
              >
                {c.id === '__all__' ? (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary"><Users className="h-3.5 w-3.5" /></span>
                ) : (
                  <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold', memberColorClass(c.id))}>{initialOf(c.name)}</span>
                )}
                {c.id === '__all__' ? t('chatroom.everyone') : c.name}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl border border-border/70 bg-card px-3 py-2 shadow-sm transition-colors focus-within:border-primary/40">
          <textarea
            ref={ref}
            rows={1}
            value={text}
            placeholder={t('chatroom.placeholder')}
            onChange={(event) => {
              setText(event.target.value);
              updateMention(event.target.value, event.target.selectionStart);
            }}
            onClick={(event) => updateMention(text, event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (mention && candidates.length) {
                if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((h) => (h + 1) % candidates.length); return; }
                if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((h) => (h - 1 + candidates.length) % candidates.length); return; }
                if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pick(candidates[highlight].name); return; }
                if (event.key === 'Escape') { setMention(null); return; }
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-sm leading-6 placeholder:text-muted-foreground/60 focus:outline-none"
          />
          {trailing}
          {busy && (
            <button
              type="button"
              onClick={() => void onStop()}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-border text-foreground hover:bg-accent"
              title={t('chatroom.stop')}
              aria-label={t('chatroom.stop')}
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          )}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!text.trim() || sending}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:bg-primary/90 disabled:opacity-40"
            title={t('chatroom.send')}
            aria-label={t('chatroom.send')}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------- 右側欄：成員與群聊設定 -----------------

function ChatroomSidebar({ def, models, onSave, onClose }: {
  def: ChatroomDef;
  models: ModelsByProvider;
  onSave: (def: ChatroomDef) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation('multiAgent');
  const [tab, setTab] = useState<'members' | 'settings'>('members');

  return (
    <aside className="flex w-full max-w-xs flex-shrink-0 flex-col border-l border-border/60 bg-background max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-20 max-md:max-w-[85vw] max-md:shadow-xl">
      <div className="flex items-center gap-1 border-b border-border/60 px-2 py-2">
        <div className="flex flex-1 rounded-lg bg-muted/50 p-0.5">
          {(['members', 'settings'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={cn('flex-1 rounded-md px-2 py-1 text-xs font-medium transition-all', tab === key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {key === 'members' ? `${t('chatroom.members')} · ${def.members.length}` : t('chatroom.settings')}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title={t('chatroom.collapse')} aria-label={t('chatroom.collapse')}>
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'members' ? (
          <div className="space-y-2">
            {def.members.map((member) => (
              <MemberCard
                key={member.id}
                member={member}
                models={models}
                onSave={(next) => onSave({ ...def, members: def.members.map((m) => (m.id === next.id ? next : m)) })}
              />
            ))}
          </div>
        ) : (
          <RulesForm rules={def.rules} onSave={(rules) => onSave({ ...def, rules })} />
        )}
      </div>
    </aside>
  );
}

function MemberCard({ member, models, onSave }: {
  member: ChatMember;
  models: ModelsByProvider;
  onSave: (member: ChatMember) => Promise<void>;
}) {
  const { t } = useTranslation('multiAgent');
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(member);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => setDraft(member), [member]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(member);

  const save = async (next = draft) => {
    setStatus(null);
    try {
      await onSave(next);
      setStatus(t('chatroom.saved'));
    } catch (error) {
      setStatus((error as Error).message);
      setDraft(member);
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left">
        <span className={cn('flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-semibold', memberColorClass(member.id))}>
          {initialOf(member.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{member.name}</span>
          <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            <SessionProviderLogo provider={member.provider} className="h-2.5 w-2.5 flex-shrink-0" />
            {modelLabel(models, member.provider, member.model)}
          </span>
        </span>
      </button>
      {!expanded && member.persona && (
        <p className="line-clamp-2 px-3 pb-2.5 text-xs text-muted-foreground">{member.persona}</p>
      )}
      {expanded && (
        <div className="space-y-3 border-t border-border/60 px-3 py-3">
          <ModelPicker
            provider={draft.provider}
            model={draft.model}
            models={models}
            onChange={(provider, model) => {
              const next = { ...draft, provider, model, permissionMode: provider === draft.provider ? draft.permissionMode : undefined };
              setDraft(next);
              void save(next);
            }}
          />
          <PermissionSelect
            provider={draft.provider}
            value={draft.permissionMode ?? MEMBER_DEFAULT_PERMISSION_MODE[draft.provider]}
            onChange={(mode) => { const next = { ...draft, permissionMode: mode }; setDraft(next); void save(next); }}
          />
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">{t('chatroom.persona')}</div>
            <textarea
              value={draft.persona}
              rows={4}
              onChange={(event) => setDraft((d) => ({ ...d, persona: event.target.value }))}
              className="w-full resize-y rounded-lg border border-border/70 bg-background px-2.5 py-1.5 text-xs leading-relaxed focus:border-primary/50 focus:outline-none"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            {status && <span className="text-[11px] text-muted-foreground">{status}</span>}
            <button
              type="button"
              disabled={!dirty}
              onClick={() => void save()}
              className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {t('chatroom.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RulesForm({ rules, onSave }: { rules: ChatRules; onSave: (rules: ChatRules) => Promise<void> }) {
  const { t } = useTranslation('multiAgent');
  const [draft, setDraft] = useState(rules);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => setDraft(rules), [rules]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(rules);
  const intField = (key: 'maxAiRepliesPerTurn', range: readonly [number, number]) => (
    <input
      type="number"
      min={range[0]}
      max={range[1]}
      step={1}
      value={Number.isFinite(draft[key]) ? draft[key] : ''}
      onChange={(event) => setDraft((d) => ({ ...d, [key]: event.target.valueAsNumber }))}
      className="w-24 rounded-lg border border-border/70 bg-background px-2 py-1 text-right text-sm focus:border-primary/50 focus:outline-none"
    />
  );

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('chatroom.rules')}</div>
        <textarea
          value={draft.text}
          rows={5}
          placeholder={t('chatroom.rulesPlaceholder')}
          onChange={(event) => setDraft((d) => ({ ...d, text: event.target.value }))}
          className="w-full resize-y rounded-lg border border-border/70 bg-background px-2.5 py-2 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none"
        />
      </div>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="text-foreground">{t('chatroom.maxAiRepliesPerTurn')}</span>
        {intField('maxAiRepliesPerTurn', MAX_AI_REPLIES_RANGE)}
      </label>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="text-foreground">{t('chatroom.allowAiMentions')}</span>
        <input
          type="checkbox"
          checked={draft.allowAiMentions}
          onChange={(event) => setDraft((d) => ({ ...d, allowAiMentions: event.target.checked }))}
          className="h-4 w-4 rounded border-border accent-primary"
        />
      </label>
      <div className="space-y-1.5 text-sm">
        <div className="text-foreground">{t('chatroom.unmentioned')}</div>
        <div className="flex rounded-lg bg-muted/50 p-0.5">
          {(['all', 'none'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setDraft((d) => ({ ...d, unmentionedBehavior: value }))}
              aria-pressed={draft.unmentionedBehavior === value}
              className={cn('flex-1 rounded-md px-2 py-1 text-xs font-medium transition-all', draft.unmentionedBehavior === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}
            >
              {value === 'all' ? t('chatroom.unmentionedAll') : t('chatroom.unmentionedNone')}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t('chatroom.limitsNote')}</p>
      <div className="flex items-center justify-end gap-2">
        {status && <span className="text-[11px] text-muted-foreground">{status}</span>}
        <button
          type="button"
          disabled={!dirty}
          onClick={() => {
            setStatus(null);
            onSave(draft).then(() => setStatus(t('chatroom.saved'))).catch((error: Error) => setStatus(error.message));
          }}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {t('chatroom.save')}
        </button>
      </div>
    </div>
  );
}

