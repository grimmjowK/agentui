import { useState } from 'react';
import { Edit3, FileText, Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { LLMProvider } from '../../../types/app';
import type { SettingsProject } from '../../settings/types/types';
import SettingsCard from '../../settings/view/SettingsCard';
import SettingsRow from '../../settings/view/SettingsRow';
import SettingsSection from '../../settings/view/SettingsSection';
import type { SkillItem, SkillScope } from '../types';
import { isSkillProvider } from '../types';
import { useSkills } from '../hooks/useSkills';

import SkillEditorModal from './SkillEditorModal';
import SkillUploadModal from './SkillUploadModal';

type SkillsContentProps = {
  selectedProvider: LLMProvider;
  currentProjects: SettingsProject[];
};

function extractSkillPreview(skill: SkillItem): string {
  if (skill.description?.trim()) {
    return skill.description.trim().split('\n')[0].slice(0, 100);
  }
  const raw = skill.content;
  if (!raw) return '';
  const trimmed = raw.trim();
  const lines = trimmed.split('\n').map((l) => l.trim()).filter((l) => l && l !== '---' && !l.startsWith('#'));
  return (lines[0] ?? '').slice(0, 100);
}

function SkillRow({
  skill,
  onEdit,
  onDelete,
}: {
  skill: SkillItem;
  onEdit: (skill: SkillItem) => void;
  onDelete: (skill: SkillItem) => void;
}) {
  const { t } = useTranslation('settings');
  const preview = extractSkillPreview(skill);

  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-muted/20">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-muted/60">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium text-foreground">{skill.name}</span>
            <span className="rounded-md bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
              {t(`skills.scope.${skill.scope}`)}
            </span>
          </div>
          {preview && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{preview}</p>
          )}
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-1">
        <button
          type="button"
          title={t('skills.actions.edit')}
          onClick={() => onEdit(skill)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Edit3 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={t('skills.actions.delete')}
          onClick={() => onDelete(skill)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function SkillGroup({
  title,
  skills,
  onEdit,
  onDelete,
}: {
  title: string;
  skills: SkillItem[];
  onEdit: (skill: SkillItem) => void;
  onDelete: (skill: SkillItem) => void;
}) {
  if (skills.length === 0) return null;
  return (
    <SettingsSection title={title}>
      <SettingsCard divided>
        {skills.map((skill) => (
          <SkillRow
            key={`${skill.scope}:${skill.name}`}
            skill={skill}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

export default function SkillsContent({ selectedProvider, currentProjects }: SkillsContentProps) {
  const { t } = useTranslation('settings');

  const workspacePath = currentProjects[0]?.fullPath ?? currentProjects[0]?.path;

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillItem | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SkillItem | null>(null);

  const skillProvider = isSkillProvider(selectedProvider) ? selectedProvider : null;

  const { skills, isLoading, error, createSkill, updateSkill, deleteSkill, uploadFile } = useSkills({
    provider: skillProvider ?? 'claude',
    workspacePath,
  });

  if (!skillProvider) {
    return (
      <SettingsSection title={t('skills.title')}>
        <SettingsCard>
          <div className="px-5 py-8 text-center text-xs text-muted-foreground">
            {t('skills.unsupported')}
          </div>
        </SettingsCard>
      </SettingsSection>
    );
  }

  const userSkills = skills.filter((s) => s.scope === 'user');
  const projectSkills = skills.filter((s) => s.scope === 'project');
  const repoSkills = skills.filter((s) => s.scope === 'repo');
  const otherSkills = skills.filter((s) => !['user', 'project', 'repo'].includes(s.scope));

  const handleEdit = (skill: SkillItem) => {
    setEditingSkill(skill);
    setEditorOpen(true);
  };

  const handleNew = () => {
    setEditingSkill(null);
    setEditorOpen(true);
  };

  const handleDelete = (skill: SkillItem) => {
    setDeleteTarget(skill);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await deleteSkill(deleteTarget.name, deleteTarget.scope);
    setDeleteTarget(null);
  };

  const handleSave = async (name: string, content: string, scope: SkillScope) => {
    if (editingSkill) {
      await updateSkill(name, content, scope);
    } else {
      await createSkill(name, content, scope);
    }
  };

  const hasAnySkills =
    userSkills.length > 0 || projectSkills.length > 0 || repoSkills.length > 0 || otherSkills.length > 0;

  return (
    <div className="space-y-6">
      <SettingsSection title={t('skills.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('skills.title')}
            description={t('skills.description')}
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setUploadOpen(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Upload className="h-3.5 w-3.5" />
                <span>{t('skills.uploadButton')}</span>
              </button>
              <button
                type="button"
                onClick={handleNew}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{t('skills.addButton')}</span>
              </button>
            </div>
          </SettingsRow>

          {error && (
            <div className="px-5 py-3 text-xs text-destructive">{error}</div>
          )}

          {isLoading && (
            <div className="flex items-center justify-center gap-2 px-5 py-8 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{t('skills.loading', { defaultValue: 'Loading skills...' })}</span>
            </div>
          )}

          {!isLoading && !error && !hasAnySkills && (
            <div className="px-5 py-8 text-center">
              <p className="text-xs font-medium text-muted-foreground">{t('skills.empty')}</p>
              <p className="mt-1 text-xs text-muted-foreground/70">{t('skills.emptyHint')}</p>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {!isLoading && hasAnySkills && (
        <div className="space-y-6">
          <SkillGroup
            title={t('skills.scopeGroup.user')}
            skills={userSkills}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
          <SkillGroup
            title={t('skills.scopeGroup.project')}
            skills={projectSkills}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
          <SkillGroup
            title={t('skills.scopeGroup.repo')}
            skills={repoSkills}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
          <SkillGroup
            title={t('skills.scopeGroup.other')}
            skills={otherSkills}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        </div>
      )}

      <SkillEditorModal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        editingSkill={editingSkill}
        onSave={handleSave}
      />

      <SkillUploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUpload={uploadFile}
      />

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDeleteTarget(null)}
          />
          <div className="relative z-50 max-w-sm rounded-2xl border border-border/70 bg-popover p-6 shadow-xl">
            <p className="text-sm text-foreground">
              {t('skills.confirmDelete', { name: deleteTarget.name })}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="h-8 rounded-lg border border-border/70 bg-muted/40 px-3 text-xs font-medium text-foreground hover:bg-muted"
              >
                {t('skills.editor.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                className="h-8 rounded-lg bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
              >
                {t('skills.actions.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
