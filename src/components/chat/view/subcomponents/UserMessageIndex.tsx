import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
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
}

// 跳转命中后的高亮反馈，复用全局搜索跳转已有的同一套闪烁动画（见 index.css
// .search-highlight-flash 与 useChatSessionState.ts 里的用法），避免为这个
// 功能重新定义一套高亮态。
const HIGHLIGHT_CLASS = 'search-highlight-flash';
const HIGHLIGHT_DURATION_MS = 4000;
// 等待 loadAllMessages 把目标消息渲染进 DOM 的重试次数/间隔。
const JUMP_RETRY_COUNT = 15;
const JUMP_RETRY_INTERVAL_MS = 200;

/**
 * 聊天区左侧贴边的用户消息索引条：把用户消息渲染成刻度，hover 弹出内容预览，
 * 点击跳转到对话中的对应位置并高亮反馈。
 *
 * 索引覆盖当前已加载到 store 的全部消息（allMessages），不局限于滚动窗口内
 * 的 visibleMessages，否则还没滚上去加载的历史会在索引里直接消失。索引不在
 * 挂载时强制拉取全量历史；点击未加载的条目时才按需加载，避免切换长会话卡顿。
 */
export default function UserMessageIndex({
  allMessages,
  scrollContainerRef,
  allMessagesLoaded,
  loadAllMessages,
}: UserMessageIndexProps) {
  const { t } = useTranslation('chat');
  const [hovered, setHovered] = useState<{ preview: string; style: CSSProperties } | null>(null);
  // 索引条贴滚动容器左边缘、纵向铺满容器可视高度，用 fixed + 实时读取容器
  // rect 实现（容器内容会撑高 overflow-y-auto 的 scrollHeight，absolute 定位
  // 会跟着内容拉长，所以不能用 absolute inset-y-0）。
  const [barStyle, setBarStyle] = useState<CSSProperties | null>(null);
  const jumpRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const updateBarStyle = () => {
      const rect = container.getBoundingClientRect();
      setBarStyle({ position: 'fixed', top: rect.top, left: rect.left, height: rect.height, zIndex: 10 });
    };

    updateBarStyle();
    const observer = new ResizeObserver(updateBarStyle);
    observer.observe(container);
    window.addEventListener('scroll', updateBarStyle, true);
    window.addEventListener('resize', updateBarStyle);

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', updateBarStyle, true);
      window.removeEventListener('resize', updateBarStyle);
    };
  }, [scrollContainerRef]);

  useEffect(() => () => {
    if (jumpRetryTimerRef.current) clearTimeout(jumpRetryTimerRef.current);
  }, []);

  const entries = useMemo<IndexEntry[]>(() => {
    return allMessages
      .filter((message) => message.type === 'user' && !message.isInterrupted)
      .map((message) => {
        const key = getIntrinsicMessageKey(message);
        const preview = String(message.content || '').trim();
        if (!key || !preview) return null;
        return { anchorId: `${USER_MESSAGE_ANCHOR_PREFIX}${key}`, preview };
      })
      .filter((entry): entry is IndexEntry => entry !== null);
  }, [allMessages]);

  if (entries.length === 0) {
    return null;
  }

  const scrollToAnchor = (target: Element) => {
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
    target.classList.add(HIGHLIGHT_CLASS);
    setTimeout(() => target.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_DURATION_MS);
  };

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
      const c = scrollContainerRef.current;
      const el = c?.querySelector(`#${CSS.escape(anchorId)}`);
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

  const handleMouseEnter = (event: React.MouseEvent<HTMLButtonElement>, preview: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHovered({
      preview,
      style: { position: 'fixed', top: rect.top, left: rect.right + 8, zIndex: 9999 },
    });
  };

  if (!barStyle || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="pointer-events-none flex w-5 flex-col items-start justify-center gap-1 rounded-r-full bg-gray-200/40 py-4 dark:bg-gray-700/30 sm:w-6"
      style={barStyle}
      aria-hidden="true"
    >
      {entries.map((entry) => (
        <button
          key={entry.anchorId}
          type="button"
          title={t('messageMinimap.jumpToMessage', { defaultValue: 'Jump to this message' })}
          onClick={() => handleJump(entry.anchorId)}
          onMouseEnter={(event) => handleMouseEnter(event, entry.preview)}
          onMouseLeave={() => setHovered(null)}
          className="pointer-events-auto h-1.5 w-4 shrink-0 rounded-full bg-gray-500 shadow-sm transition-colors hover:bg-blue-500 dark:bg-gray-400 dark:hover:bg-blue-400 sm:w-5"
        />
      ))}
      {hovered && (
        <div
          style={hovered.style}
          className="line-clamp-3 max-w-xs whitespace-pre-wrap break-words rounded-md bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-gray-100 dark:text-gray-900"
        >
          {hovered.preview}
        </div>
      )}
    </div>,
    document.body
  );
}
