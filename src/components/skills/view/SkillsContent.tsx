import { useState } from 'react';
import { Edit3, FileText, Plus, Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { LLMProvider } from '../../../types/app';
import type { SettingsProject } from '../../settings/types/types';
import type { SkillItem, SkillScope } from '../types';
import { isSkillProvider } from '../types';
import { useSkills } from '../hooks/useSkills';
import { Badge, Button } from '../../../shared/view/ui';

import SkillEditorModal from './SkillEditorModal';
import SkillUploadModal from './SkillUploadModal';

type SkillsContentProps = {
  selectedProvider: LLMProvider;
  currentProjects: SettingsProject[];
};

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
  const preview = (skill.content ?? '').trim().split('\n')[0]?.slice(0, 80) ?? '';

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:bg-accent/30">
      <FileText className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{skill.name}</span>
          <Badge variant="secondary" className="text-xs">
            {t(`skills.scope.${skill.scope}`)}
          </Badge>
        </div>
        {preview && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{preview}</p>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        <button
          type="button"
          title={t('skills.actions.edit')}
          onClick={() => onEdit(skill)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Edit3 className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t('skills.actions.delete')}
          onClick={() => onDelete(skill)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function SkillGroup({ title, skills, onEdit, onDelete }: {
  title: string;
  skills: SkillItem[];
  onEdit: (skill: SkillItem) => void;
  onDelete: (skill: SkillItem) => void;
}) {
  if (skills.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {skills.map((skill) => (
        <SkillRow key={`${skill.scope}:${skill.name}`} skill={skill} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </div>
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
      <div className="flex h-full items-center justify-center py-12 text-center">
        <p className="text-sm text-muted-foreground">{t('skills.unsupported')}</p>
      </div>
    );
  }

  const userSkills = skills.filter((s) => s.scope === 'user');
  const projectSkills = skills.filter((s) => s.scope === 'project');

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileText className="h-5 w-5 text-blue-500" />
          <h3 className="text-lg font-medium text-foreground">{t('skills.title')}</h3>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
            <Upload className="mr-2 h-4 w-4" />
            {t('skills.uploadButton')}
          </Button>
          <Button size="sm" onClick={handleNew}>
            <Plus className="mr-2 h-4 w-4" />
            {t('skills.addButton')}
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{t('skills.description')}</p>

      {isLoading && (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>
      )}

      {error && (
        <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {!isLoading && !error && skills.length === 0 && (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 py-10 text-center">
          <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm font-medium text-muted-foreground">{t('skills.empty')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('skills.emptyHint')}</p>
        </div>
      )}

      {!isLoading && (userSkills.length > 0 || projectSkills.length > 0) && (
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
            className="fixed inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setDeleteTarget(null)}
          />
          <div className="relative z-50 max-w-sm rounded-xl border bg-popover p-6 shadow-lg">
            <p className="text-sm text-foreground">
              {t('skills.confirmDelete', { name: deleteTarget.name })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
                {t('skills.editor.cancel')}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void confirmDelete()}>
                {t('skills.actions.delete')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
