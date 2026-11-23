import { cn } from '../../../lib/utils';

type SettingsToggleProps = {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
};

export default function SettingsToggle({ checked, onChange, ariaLabel, disabled }: SettingsToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        'relative inline-flex h-6 w-11 flex-shrink-0 touch-manipulation cursor-pointer items-center rounded-full p-0.5 transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        checked ? 'bg-[#3b82f6] dark:bg-[#3b82f6]' : 'bg-foreground/15 dark:bg-white/15',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}
