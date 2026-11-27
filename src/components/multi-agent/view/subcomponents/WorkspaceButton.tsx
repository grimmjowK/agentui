/**
 * 頁首的工作目錄：顯示目前目錄，點擊用資料夾瀏覽器更換。
 * 工作目錄決定節點與成員讀到哪些 CLAUDE.md / AGENTS.md / skills。
 */
import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../utils/api';
import { FolderBrowserModal } from '../../../project-creation-wizard';
import type { MultiAgent } from '../../types/types';
import { readData } from '../../utils/fetchJson';

type WorkspaceButtonProps = {
  agent: MultiAgent;
  onChange: (agent: MultiAgent) => void;
};

export default function WorkspaceButton({ agent, onChange }: WorkspaceButtonProps) {
  const { t } = useTranslation('multiAgent');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDefault = /[\\/]\.cloudcli[\\/]multi-agent[\\/]/.test(agent.workspacePath);
  const label = isDefault ? t('workspace.default') : agent.workspacePath.split(/[\\/]/).filter(Boolean).pop();

  const select = async (folderPath: string) => {
    setOpen(false);
    setError(null);
    try {
      onChange(await readData<MultiAgent>(api.multiAgent.update(agent.id, { workspacePath: folderPath })));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${t('workspace.title')}: ${agent.workspacePath}${error ? `\n${error}` : ''}`}
        className={`flex max-w-56 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs hover:bg-accent ${
          error ? 'text-destructive' : isDefault ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="truncate">{error ?? label}</span>
      </button>
      <FolderBrowserModal
        isOpen={open}
        autoAdvanceOnSelect={false}
        onClose={() => setOpen(false)}
        onFolderSelected={(folderPath) => void select(folderPath)}
      />
    </>
  );
}
