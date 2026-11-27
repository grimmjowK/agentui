/**
 * 按 provider 分組的模型下拉，節點與成員共用。
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import { PROVIDER_IDS, type LLMProvider } from '../../../../../shared/providers';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { cn } from '../../../../lib/utils';
import { modelLabel, type ModelsByProvider } from '../../hooks/useProviderModels';

const PROVIDER_NAMES: Record<LLMProvider, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', antigravity: 'Antigravity' };

type ModelPickerProps = {
  provider: LLMProvider;
  model: string;
  models: ModelsByProvider;
  disabled?: boolean;
  onChange: (provider: LLMProvider, model: string) => void;
};

export default function ModelPicker({ provider, model, models, disabled, onChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 py-1.5 text-left text-sm transition-colors hover:border-border disabled:cursor-not-allowed disabled:opacity-60"
      >
        <SessionProviderLogo provider={provider} className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="min-w-0 flex-1 truncate">{modelLabel(models, provider, model)}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border/60 bg-popover p-1 shadow-lg">
          {PROVIDER_IDS.filter((p) => models[p]?.length).map((p) => (
            <div key={p} className="py-0.5">
              <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <SessionProviderLogo provider={p} className="h-3 w-3" />{PROVIDER_NAMES[p]}
              </div>
              {models[p]!.map((option) => {
                const selected = p === provider && option.value === model;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => { onChange(p, option.value); setOpen(false); }}
                    className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', selected && 'bg-accent/60')}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {selected && <Check className="h-3.5 w-3.5 text-primary" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
