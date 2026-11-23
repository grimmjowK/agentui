import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

type SettingsSectionProps = {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
};

export default function SettingsSection({ title, description, children, className }: SettingsSectionProps) {
  return (
    <section className={cn('space-y-2.5', className)}>
      <div className="px-0.5">
        <h3 className="text-[13px] font-medium text-foreground/80">
          {title}
        </h3>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}
