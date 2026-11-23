import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';

import { languages } from '../../../i18n/languages';

type LanguageSelectorProps = {
  compact?: boolean;
};

export default function LanguageSelector({ compact = false }: LanguageSelectorProps) {
  const { i18n, t } = useTranslation('settings');

  const handleLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const newLanguage = event.target.value;
    i18n.changeLanguage(newLanguage);
  };

  if (compact) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-transparent bg-muted/50 p-3 transition-colors hover:border-border hover:bg-accent">
        <span className="flex items-center gap-2 text-sm text-foreground">
          <Languages className="h-4 w-4 text-muted-foreground" />
          {t('account.language')}
        </span>
        <select
          value={i18n.language}
          onChange={handleLanguageChange}
          className="h-8 rounded-lg border border-border/70 bg-muted/40 pl-2.5 pr-7 text-xs font-medium text-foreground transition-colors hover:bg-muted/70 focus:border-primary focus:outline-none"
        >
          {languages.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.nativeName}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium leading-snug text-foreground">
          {t('account.languageLabel')}
        </div>
        <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          {t('account.languageDescription')}
        </div>
      </div>
      <select
        value={i18n.language}
        onChange={handleLanguageChange}
        className="h-8 flex-shrink-0 rounded-lg border border-border/70 bg-muted/40 pl-3 pr-7 text-xs font-medium text-foreground transition-colors hover:bg-muted/70 focus:border-primary focus:outline-none"
      >
        {languages.map((lang) => (
          <option key={lang.value} value={lang.value}>
            {lang.nativeName}
          </option>
        ))}
      </select>
    </div>
  );
}
