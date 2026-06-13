import { useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import type { SkillScope } from '../types';
import { Button } from '../../../shared/view/ui';

type SkillUploadModalProps = {
  open: boolean;
  onClose: () => void;
  onUpload: (file: File, scope: SkillScope) => Promise<string[]>;
};

export default function SkillUploadModal({ open, onClose, onUpload }: SkillUploadModalProps) {
  const { t } = useTranslation('settings');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [scope, setScope] = useState<SkillScope>('user');
  const [isUploading, setIsUploading] = useState(false);
  const [typeError, setTypeError] = useState(false);
  const [successCount, setSuccessCount] = useState<number | null>(null);

  useEffect(() => {
    if (open) {
      setFile(null);
      setScope('user');
      setIsUploading(false);
      setTypeError(false);
      setSuccessCount(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    if (selected) {
      const valid = selected.name.endsWith('.md') || selected.name.endsWith('.zip');
      setTypeError(!valid);
      setFile(valid ? selected : null);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setIsUploading(true);
    try {
      const imported = await onUpload(file, scope);
      setSuccessCount(imported.length);
      setTimeout(() => onClose(), 1500);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
      <div
        className="w-full max-w-md rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">{t('skills.upload.title')}</h2>
        </div>

        <div className="space-y-4 px-6 py-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              {t('skills.upload.selectFile')}
            </label>
            <div
              className="flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-input p-6 transition-colors hover:bg-muted/40"
              onClick={() => fileInputRef.current?.click()}
            >
              <p className="text-sm text-muted-foreground">
                {file ? file.name : t('skills.upload.dragHint')}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.zip"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
            {typeError && (
              <p className="text-xs text-destructive">{t('skills.upload.invalidType')}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              {t('skills.upload.scope')}
            </label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as SkillScope)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="user">{t('skills.scope.user')}</option>
              <option value="project">{t('skills.scope.project')}</option>
            </select>
          </div>

          {successCount !== null && (
            <p className="text-sm text-green-600 dark:text-green-400">
              {t('skills.upload.successCount', { count: successCount })}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <Button variant="outline" size="sm" onClick={onClose} disabled={isUploading}>
            {t('skills.upload.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleUpload()}
            disabled={!file || isUploading || typeError}
          >
            {isUploading ? t('skills.upload.uploading') : t('skills.upload.upload')}
          </Button>
        </div>
      </div>
    </div>
  );
}
