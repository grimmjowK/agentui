import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';
import { copyTextToClipboard } from '../../../../utils/clipboard';

type ResumeInfo = {
  nativeId: string;
  transcriptPath: string | null;
  resumeCommand: string | null;
};

type SessionIdBadgeProps = {
  sessionId: string;
  provider?: string;
};

/**
 * 标题下方的会话 ID 小标签：点开可复制完整 ID、外部终端 resume 命令、转录文件路径。
 * 用于应用出问题时切到 CLI 接着跑，或把转录交给 AI 排查。
 */
export default function SessionIdBadge({ sessionId, provider = 'claude' }: SessionIdBadgeProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [info, setInfo] = useState<ResumeInfo | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});

  useEffect(() => {
    setInfo(null);
    setIsOpen(false);
  }, [sessionId]);

  // 打开时才查：resume 命令要用后端解析的原生 ID 与项目路径
  useEffect(() => {
    if (!isOpen || info) return;
    let cancelled = false;
    authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/resume-info?provider=${encodeURIComponent(provider)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body?.data) setInfo(body.data as ResumeInfo);
      })
      .catch((error) => console.error('Failed to load session resume info:', error));
    return () => {
      cancelled = true;
    };
  }, [isOpen, info, sessionId, provider]);

  // 标题容器带横向滚动会裁掉绝对定位的浮层，所以挂到 body 上按触发器位置定位
  useEffect(() => {
    if (!isOpen) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPanelStyle({ position: 'fixed', top: rect.bottom + 6, left: rect.left, zIndex: 80 });

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const copy = useCallback(async (key: string, text: string) => {
    if (await copyTextToClipboard(text)) {
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1500);
    }
  }, []);

  const items = [
    { key: 'id', label: t('mainContent.sessionInfo.copyId'), value: sessionId },
    { key: 'resume', label: t('mainContent.sessionInfo.copyResume'), value: info?.resumeCommand },
    { key: 'transcript', label: t('mainContent.sessionInfo.copyTranscript'), value: info?.transcriptPath },
  ];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        title={sessionId}
        className="flex-shrink-0 rounded px-1 font-mono text-[11px] leading-tight text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {provider} · {sessionId.slice(0, 8)}
      </button>

      {isOpen && createPortal(
        <div
          ref={panelRef}
          style={panelStyle}
          className="w-80 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              disabled={!item.value}
              onClick={() => item.value && copy(item.key, item.value)}
              className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent"
            >
              {copiedKey === item.key
                ? <Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-600" />
                : <Copy className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{copiedKey === item.key ? t('mainContent.sessionInfo.copied') : item.label}</span>
                <span className="block break-all font-mono text-[11px] text-muted-foreground">
                  {item.value ?? (info ? t('mainContent.sessionInfo.unavailable') : '…')}
                </span>
              </span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
