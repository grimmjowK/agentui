import { Moon, Sun } from 'lucide-react';

import { useTheme } from '../../../contexts/ThemeContext';
import { cn } from '../../../lib/utils';

type DarkModeToggleProps = {
  checked?: boolean;
  onToggle?: (nextValue: boolean) => void;
  ariaLabel?: string;
};

function DarkModeToggle({
  checked,
  onToggle,
  ariaLabel = 'Toggle dark mode',
}: DarkModeToggleProps) {
  const { isDarkMode, toggleDarkMode } = useTheme();
  const isControlled = typeof checked === 'boolean' && typeof onToggle === 'function';
  const isEnabled = isControlled ? checked : isDarkMode;

  const handleToggle = () => {
    if (isControlled && onToggle) {
      onToggle(!isEnabled);
      return;
    }

    toggleDarkMode();
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={cn(
        'relative inline-flex h-6 w-11 flex-shrink-0 touch-manipulation cursor-pointer items-center rounded-full p-0.5 transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        isEnabled ? 'bg-[#3b82f6] dark:bg-[#3b82f6]' : 'bg-foreground/15 dark:bg-white/15',
      )}
      role="switch"
      aria-checked={isEnabled}
      aria-label={ariaLabel}
    >
      <span className="sr-only">{ariaLabel}</span>
      <span
        className={cn(
          'flex h-5 w-5 transform items-center justify-center rounded-full bg-white shadow-sm transition-transform duration-200',
          isEnabled ? 'translate-x-5' : 'translate-x-0',
        )}
      >
        {isEnabled ? (
          <Moon className="h-3 w-3 text-[#3b82f6]" />
        ) : (
          <Sun className="h-3 w-3 text-amber-500" />
        )}
      </span>
    </button>
  );
}

export default DarkModeToggle;
