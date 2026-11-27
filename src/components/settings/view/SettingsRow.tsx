import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

type SettingsRowProps = {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
};

export default function SettingsRow({ label, description, children, className, onClick }: SettingsRowProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'flex items-center justify-between gap-6 px-5 py-4 transition-colors',
        onClick && 'cursor-pointer hover:bg-muted/25',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium leading-snug text-foreground">{label}</div>
        {description && (
          <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
