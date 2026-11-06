import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Markdown } from '../../../chat/view/subcomponents/Markdown';
import type { SessionArtifact } from '../../hooks/useSessionArtifacts';

type SessionArtifactsPanelProps = {
  artifacts: SessionArtifact[];
  onClose: () => void;
};

/** 對話流外的右側產物預覽，以分頁切換各個 .md 產物。 */
export default function SessionArtifactsPanel({ artifacts, onClose }: SessionArtifactsPanelProps) {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = artifacts.find((artifact) => artifact.id === activeId) ?? artifacts[0] ?? null;

  useEffect(() => {
    if (activeId && !artifacts.some((artifact) => artifact.id === activeId)) setActiveId(null);
  }, [activeId, artifacts]);

  return (
    <aside className="flex w-80 flex-shrink-0 flex-col border-l border-border/60 bg-background lg:w-96">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <h3 className="text-sm font-medium">{t('artifacts.title')}</h3>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t('artifacts.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {artifacts.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-border/60 px-2 py-1.5" role="tablist">
          {artifacts.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              role="tab"
              aria-selected={artifact.id === active?.id}
              onClick={() => setActiveId(artifact.id)}
              className={`whitespace-nowrap rounded px-2 py-1 text-xs ${
                artifact.id === active?.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
              }`}
            >
              {artifact.fileName}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {active ? (
          <>
            <p className="mb-2 text-[11px] text-muted-foreground">
              {active.fileName} · {new Date(active.updatedAt).toLocaleString()}
            </p>
            <Markdown className="prose prose-sm max-w-none dark:prose-invert">{active.content}</Markdown>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('artifacts.empty')}</p>
        )}
      </div>
    </aside>
  );
}
