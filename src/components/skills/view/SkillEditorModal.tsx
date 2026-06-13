import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { SkillItem, SkillScope } from '../types';
import { Button, Input } from '../../../shared/view/ui';

type SkillEditorModalProps = {
  open: boolean;
  onClose: () => void;
  editingSkill: SkillItem | null;
  onSave: (name: string, content: string, scope: SkillScope) => Promise<void>;
};

export default function SkillEditorModal({
  open,
  onClose,
  editingSkill,
  onSave,
}: SkillEditorModalProps) {
  const { t } = useTranslation('settings');
  const isEdit = editingSkill !== null;
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [scope, setScope] = useState<SkillScope>('user');
  const [isSaving, setIsSaving] = useState(false);
  const [nameError, setNameError] = useState(false);

  useEffect(() => {
    if (open) {
      setName(editingSkill?.name ?? '');
      setContent(editingSkill?.content ?? '');
      setScope(editingSkill?.scope ?? 'user');
      setNameError(false);
      setIsSaving(false);
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [open, editingSkill]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    if (!name.trim()) {
      setNameError(true);
      return;
    }
    setIsSaving(true);
    try {
      await onSave(name.trim(), content, scope);
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
      <div
        className="w-full max-w-2xl rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">
            {isEdit ? t('skills.editor.titleEdit') : t('skills.editor.titleCreate')}
          </h2>
        </div>

        <div className="space-y-4 px-6 py-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              {t('skills.editor.name')}
            </label>
            {isEdit ? (
              <div className="flex h-9 w-full items-center rounded-md border border-input bg-muted px-3 py-1 text-sm text-muted-foreground">
                {name}
              </div>
            ) : (
              <Input
                ref={nameInputRef}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(false);
                }}
                placeholder={t('skills.editor.namePlaceholder')}
                className={nameError ? 'border-destructive focus-visible:ring-destructive' : ''}
              />
            )}
            {nameError && (
              <p className="text-xs text-destructive">{t('skills.editor.nameRequired')}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              {t('skills.editor.scope')}
            </label>
            {isEdit ? (
              <div className="flex h-9 w-full items-center rounded-md border border-input bg-muted px-3 py-1 text-sm text-muted-foreground">
                {t(`skills.scope.${scope}`)}
              </div>
            ) : (
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as SkillScope)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="user">{t('skills.scope.user')}</option>
                <option value="project">{t('skills.scope.project')}</option>
              </select>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              {t('skills.editor.content')}
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t('skills.editor.contentPlaceholder')}
              rows={14}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <Button variant="outline" size="sm" onClick={onClose} disabled={isSaving}>
            {t('skills.editor.cancel')}
          </Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? t('skills.editor.saving') : t('skills.editor.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
