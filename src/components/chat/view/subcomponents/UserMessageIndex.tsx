import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import type { ChatMessage } from '../../types/types';
import { getIntrinsicMessageKey } from '../../utils/messageKeys';
import { USER_MESSAGE_ANCHOR_PREFIX } from './MessageComponent';

interface UserMessageIndexProps {
  /** 当前会话已加载进 store 的全部消息（不是分页窗口内的 visibleMessages），
   * 索引要能覆盖到还没滚到的历史记录。 */
  allMessages: ChatMessage[];
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** 历史是否已全部加载进 store（用于判断点某条索引时目标是否已在 DOM 里）。 */
  allMessagesLoaded: boolean;
  /** 触发一次性拉取全部历史（复用搜索跳转已有的同一个入口）。 */
  loadAllMessages: (options?: { silent?: boolean }) => void;
}

interface IndexEntry {
  anchorId: string;
  preview: string;
  /** 该条用户消息之后第一条助手文本回复，用于 hover 卡片的第二段。 */
  reply: string;
}

// 跳转命中后的高亮反馈，复用全局搜索跳转已有的同一套闪烁动画（见 index.css
// .search-highlight-flash 与 useChatSessionState.ts 里的用法）。
const HIGHLIGHT_CLASS = 'search-highlight-flash';
const HIGHLIGHT_DURATION_MS = 4000;
// 等待 loadAllMessages 把目标消息渲染进 DOM 的重试次数/间隔。
const JUMP_RETRY_COUNT = 15;
const JUMP_RETRY_INTERVAL_MS = 200;
// 每个刻度占的行高（含间距）：条目少时用最大值，放不下时按可用高度收窄，
// 收到最小值仍放不下则索引条自身滚动。
const ROW_PITCH_MAX = 14;
const ROW_PITCH_MIN = 4;
const BAR_PADDING_Y = 16;
// 视口中线所在的用户消息视为"当前位置"（与跳转时 block:'center' 对齐）。
const ACTIVE_LINE_RATIO = 0.5;

/**
 * 聊天区左侧的用户消息索引条：把用户消息渲染成刻度，hover 弹出问答预览，
 * 点击跳转到对话中的对应位置，并随滚动高亮当前所在的条目。
 *
 * 索引覆盖当前已加载到 store 的全部消息（allMessages）。挂载时静默拉全量历史
 * 进 store（不放大渲染窗口）；点击窗口外的条目时再放开窗口并跳转。
 * 滚动容器在 ChatMessagesPane 里为索引条预留了左侧 gutter，所以不会遮挡正文。
 */
export default function UserMessageIndex({
  allMessages,
  scrollContainerRef,
  allMessagesLoaded,
  loadAllMessages,
}: UserMessageIndexProps) {
  const { t } = useTranslation('chat');
  const [hovered, setHovered] = useState<{ entry: IndexEntry; style: CSSProperties } | null>(null);
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  // 索引条贴滚动容器左边缘、纵向铺满容器可视高度，用 fixed + 实时读取容器
  // rect 实现（absolute 会跟着 scrollHeight 拉长）。
  const [barStyle, setBarStyle] = useState<CSSProperties | null>(null);
  const jumpRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let rafId: number | null = null;
    const updateBarStyle = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          setBarStyle(null);
          setHovered(null);
          return;
        }
        setBarStyle((prev) => {
          if (prev && prev.top === rect.top && prev.left === rect.left && prev.height === rect.height) {
            return prev;
          }
          return { position: 'fixed', top: rect.top, left: rect.left, height: rect.height, zIndex: 10 };
        });
      });
    };

    updateBarStyle();
    const observer = new ResizeObserver(updateBarStyle);
    observer.observe(container);
    window.addEventListener('resize', updateBarStyle);

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', updateBarStyle);
    };
  }, [scrollContainerRef]);

  useEffect(() => () => {
    if (jumpRetryTimerRef.current) clearTimeout(jumpRetryTimerRef.current);
  }, []);

  // 首屏只分页拉了最新一页，静默补全全量历史进 store，索引才能一开始就覆盖
  // 所有用户消息。silent 模式不放大渲染窗口，不会因此卡顿。
  useEffect(() => {
    if (!allMessagesLoaded) loadAllMessages({ silent: true });
  }, [allMessagesLoaded, loadAllMessages]);

  const entries = useMemo<IndexEntry[]>(() => {
    const result: IndexEntry[] = [];
    let last: IndexEntry | null = null;
    for (const message of allMessages) {
      if (message.type === 'user') {
        last = null;
        if (message.isInterrupted) continue;
        const key = getIntrinsicMessageKey(message);
        const preview = String(message.content || '').trim();
        if (!key || !preview) continue;
        last = { anchorId: `${USER_MESSAGE_ANCHOR_PREFIX}${key}`, preview, reply: '' };
        result.push(last);
      } else if (
        last &&
        !last.reply &&
        message.type === 'assistant' &&
        !message.isToolUse &&
        !message.isThinking
      ) {
        last.reply = String(message.content || '').trim();
      }
    }
    return result;
  }, [allMessages]);

  // 随滚动计算当前所在的用户消息：DOM 里的锚点按文档顺序即时间顺序，
  // 二分找最后一个顶部越过"当前线"的锚点。rAF 节流，一帧最多算一次。
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let rafId: number | null = null;
    const update = () => {
      rafId = null;
      const anchors = container.querySelectorAll<HTMLElement>(`[id^="${USER_MESSAGE_ANCHOR_PREFIX}"]`);
      if (anchors.length === 0) return;
      const rect = container.getBoundingClientRect();
      // 已滚到底时最后一条可能到不了中线，此时把判定线放到底边。
      const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
      const line = atBottom ? rect.bottom : rect.top + rect.height * ACTIVE_LINE_RATIO;
      let lo = 0;
      let hi = anchors.length - 1;
      let found = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (anchors[mid].getBoundingClientRect().top <= line) {
          found = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const id = anchors[found].id;
      setActiveAnchorId((prev) => (prev === id ? prev : id));
    };
    const onScroll = () => {
      if (rafId === null) rafId = window.requestAnimationFrame(update);
    };

    onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      container.removeEventListener('scroll', onScroll);
    };
  }, [scrollContainerRef, entries]);

  const scrollToAnchor = useCallback((target: Element) => {
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
    setActiveAnchorId(target.id);
    target.classList.add(HIGHLIGHT_CLASS);
    setTimeout(() => target.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_DURATION_MS);
  }, []);

  const handleJump = (anchorId: string) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const target = container.querySelector(`#${CSS.escape(anchorId)}`);
    if (target) {
      scrollToAnchor(target);
      return;
    }

    // 目标消息还没加载进 DOM（在未展示的历史里）：先拉全量历史，再等锚点出现。
    loadAllMessages();

    if (jumpRetryTimerRef.current) clearTimeout(jumpRetryTimerRef.current);
    const retry = (retriesLeft: number) => {
      const el = scrollContainerRef.current?.querySelector(`#${CSS.escape(anchorId)}`);
      if (el) {
        scrollToAnchor(el);
        return;
      }
      if (retriesLeft > 0) {
        jumpRetryTimerRef.current = setTimeout(() => retry(retriesLeft - 1), JUMP_RETRY_INTERVAL_MS);
      }
    };
    retry(JUMP_RETRY_COUNT);
  };

  const handleMouseEnter = (event: React.MouseEvent<HTMLButtonElement>, entry: IndexEntry) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // 卡片垂直居中对齐刻度，并夹在视口内（卡片最大高度约 180px）。
    const top = Math.min(Math.max(rect.top + rect.height / 2 - 40, 8), window.innerHeight - 188);
    setHovered({ entry, style: { position: 'fixed', top, left: rect.right + 8, zIndex: 9999 } });
  };

  if (entries.length === 0 || !barStyle || typeof document === 'undefined') {
    return null;
  }

  const availableHeight = Number(barStyle.height) - BAR_PADDING_Y * 2;
  const rowPitch = Math.max(ROW_PITCH_MIN, Math.min(ROW_PITCH_MAX, Math.floor(availableHeight / entries.length)));
  const tickHeight = rowPitch >= 8 ? 2 : 1.5;

  return createPortal(
    <>
      <nav
        className="scrollbar-hide flex w-9 flex-col overflow-y-auto py-4 sm:w-12"
        style={barStyle}
        aria-label={t('messageMinimap.jumpToMessage', { defaultValue: 'Jump to this message' })}
      >
        {/* my-auto：条目少时整体垂直居中，溢出时从顶部开始可滚动 */}
        <div className="my-auto flex flex-col">
          {entries.map((entry) => {
            const isActive = entry.anchorId === activeAnchorId;
            return (
              <button
                key={entry.anchorId}
                type="button"
                aria-label={entry.preview.slice(0, 80)}
                aria-current={isActive ? 'location' : undefined}
                onClick={() => handleJump(entry.anchorId)}
                onMouseEnter={(event) => handleMouseEnter(event, entry)}
                onMouseLeave={() => setHovered(null)}
                className="group flex w-full shrink-0 items-center pl-2 sm:pl-3"
                style={{ height: rowPitch }}
              >
                <span
                  className={`block rounded-full transition-all duration-150 ${
                    isActive
                      ? 'w-6 bg-foreground'
                      : 'w-4 bg-muted-foreground/40 group-hover:w-6 group-hover:bg-muted-foreground'
                  }`}
                  style={{ height: tickHeight }}
                />
              </button>
            );
          })}
        </div>
      </nav>
      {hovered && (
        <div
          style={hovered.style}
          className="pointer-events-none w-80 max-w-[calc(100vw-4rem)] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm font-medium">{hovered.entry.preview}</p>
          {hovered.entry.reply && (
            <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {hovered.entry.reply}
            </p>
          )}
        </div>
      )}
    </>,
    document.body
  );
}
