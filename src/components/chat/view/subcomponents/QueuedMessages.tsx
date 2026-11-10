import { useTranslation } from 'react-i18next';
import { CornerDownRightIcon, ImageIcon, Loader2Icon, SendHorizonalIcon, XIcon } from 'lucide-react';

import type { QueuedMessage } from '../../../../stores/queuedMessagesStore';

interface QueuedMessagesProps {
  items: QueuedMessage[];
  isLoading: boolean;
  /** provider 支援執行中插話且這一輪正在跑 */
  canSteer: boolean;
  onSteer: (item: QueuedMessage) => void;
  onSend: (item: QueuedMessage) => void;
  onRemove: (id: string) => void;
}

const iconButton =
  'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

/** 輸入框上方的待送佇列（chat-queued-steer-composer design D5）。 */
export default function QueuedMessages({ items, isLoading, canSteer, onSteer, onSend, onRemove }: QueuedMessagesProps) {
  const { t } = useTranslation('chat');
  if (items.length === 0) return null;
  const anySteering = items.some((item) => item.steering);

  return (
    <div className="mx-auto mb-2 max-w-4xl space-y-1" aria-label={t('steer.queued')}>
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-2 rounded-xl border border-border/50 bg-card/80 px-3 py-1.5 text-sm shadow-sm"
        >
          <span className="min-w-0 flex-1 truncate text-foreground/80" title={item.text}>
            {item.text || t('steer.imageOnly')}
          </span>
          {item.images.length > 0 && (
            <span className="flex flex-shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <ImageIcon className="h-3.5 w-3.5" />
              {item.images.length}
            </span>
          )}
          {item.steering ? (
            <Loader2Icon className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground" aria-label={t('steer.steering')} />
          ) : isLoading ? (
            canSteer && item.images.length === 0 && (
              <button
                type="button"
                className={iconButton}
                disabled={anySteering}
                onClick={() => onSteer(item)}
                title={t('steer.steerNow')}
                aria-label={t('steer.steerNow')}
              >
                <CornerDownRightIcon className="h-4 w-4" />
              </button>
            )
          ) : (
            <button
              type="button"
              className={iconButton}
              onClick={() => onSend(item)}
              title={t('steer.sendNow')}
              aria-label={t('steer.sendNow')}
            >
              <SendHorizonalIcon className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            className={iconButton}
            disabled={item.steering}
            onClick={() => onRemove(item.id)}
            title={t('steer.remove')}
            aria-label={t('steer.remove')}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
