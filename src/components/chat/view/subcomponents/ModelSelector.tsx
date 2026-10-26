import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../utils/api';
import {
  ANTIGRAVITY_MODELS,
  CLAUDE_MODELS,
  CODEX_MODELS,
  CURSOR_MODELS,
  GEMINI_MODELS,
} from '../../../../../shared/modelConstants';

type ModelOption = { value: string; label: string; description?: string };

const MODELS_BY_PROVIDER: Record<string, { OPTIONS: ModelOption[] }> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  cursor: CURSOR_MODELS,
  gemini: GEMINI_MODELS,
  antigravity: ANTIGRAVITY_MODELS,
};

/** provider → 已取到的实时清单。跨组件实例共享，避免每次开面板都打一次 CLI */
const liveModelsCache = new Map<string, ModelOption[]>();

type ModelSelectorProps = {
  provider: string;
  model: string;
  onModelChange: (value: string) => void;
  /** 受控：`/model` 指令也要能把这个面板拉起来 */
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * 输入框右下角的模型选择器（Codex 风格）。
 *
 * 面板走 portal —— PromptInput 那层 form 是 overflow-hidden 的，
 * 绝对定位的子元素会被裁掉。composer 恒贴视口底部，所以一律向上弹。
 */
export default function ModelSelector({
  provider,
  model,
  onModelChange,
  isOpen,
  onOpenChange,
}: ModelSelectorProps) {
  const { t } = useTranslation('chat');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const [liveModels, setLiveModels] = useState<ModelOption[] | null>(() => liveModelsCache.get(provider) ?? null);
  const [isLoading, setIsLoading] = useState(false);

  const options = liveModels ?? (MODELS_BY_PROVIDER[provider] ?? CLAUDE_MODELS).OPTIONS;
  // 模型可能来自 localStorage 或 Cursor 配置，不一定在当前清单里，此时直接显示原值
  const currentLabel = options.find((option) => option.value === model)?.label || model;

  /** 拉取该 provider 的实时模型清单；失败时静默保留内置清单 */
  const loadModels = useCallback(async (refresh = false) => {
    setIsLoading(true);
    try {
      const response = await api.providerModels(provider, { refresh });
      const payload = await response.json();
      const models: ModelOption[] = payload?.data?.models ?? [];
      if (models.length > 0) {
        liveModelsCache.set(provider, models);
        setLiveModels(models);
      }
    } catch (error) {
      console.warn('[ModelSelector] 获取模型列表失败，沿用内置清单:', error);
    } finally {
      setIsLoading(false);
    }
  }, [provider]);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const padding = 16;
    const width = Math.min(300, window.innerWidth - padding * 2);
    setStyle({
      position: 'fixed',
      bottom: window.innerHeight - rect.top + 8,
      left: Math.max(padding, Math.min(rect.right - width, window.innerWidth - width - padding)),
      width,
      maxHeight: Math.max(180, rect.top - padding - 8),
      zIndex: 80,
    });
  }, []);

  // 切换 provider 时换成该 provider 的缓存（没有则先用内置清单）
  useEffect(() => {
    setLiveModels(liveModelsCache.get(provider) ?? null);
  }, [provider]);

  useEffect(() => {
    if (!isOpen) {
      setStyle(null);
      return;
    }

    // 首次打开才去查，避免每次进聊天页都拉起一次 CLI
    if (!liveModelsCache.has(provider)) void loadModels();

    const rafId = window.requestAnimationFrame(place);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };

    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, place, onOpenChange, provider, loadModels]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => onOpenChange(!isOpen)}
        className="flex max-w-36 items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:max-w-56"
        title={t('providerSelection.selectModel')}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-60" />
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={panelRef}
            style={style || { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }}
            className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card shadow-xl"
            role="listbox"
          >
            <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
              <span>{t('providerSelection.selectModel')}</span>
              <button
                type="button"
                onClick={() => void loadModels(true)}
                disabled={isLoading}
                className="rounded p-1 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                title={t('common:buttons.refresh')}
              >
                <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <div className="min-h-0 overflow-y-auto py-1">
              {options.map((option) => {
                const isSelected = option.value === model;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onModelChange(option.value);
                      onOpenChange(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-accent ${
                      isSelected ? 'bg-accent/60' : ''
                    }`}
                    title={option.description || option.value}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-foreground">{option.label}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {option.value}
                      </span>
                    </span>
                    {isSelected && <Check className="h-4 w-4 flex-shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
