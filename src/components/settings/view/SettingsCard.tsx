import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

type SettingsCardProps = {
  children: ReactNode;
  className?: string;
  divided?: boolean;
};

export default function SettingsCard({ children, className, divided }: SettingsCardProps) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border border-border/60 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.03)] dark:bg-card/70',
        divided && 'divide-y divide-border/50',
        className,
      )}
    >
      {children}
    </div>
  );
}
