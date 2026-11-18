import os from 'node:os';
import path from 'node:path';

/** 沒有綁定專案的多 Agent 使用的專屬工作目錄根；這些目錄不出現在側邊欄專案列表。 */
export const MULTI_AGENT_WORKSPACE_ROOT = path.join(os.homedir(), '.cloudcli', 'multi-agent');

export function isMultiAgentWorkspace(projectPath: string): boolean {
  const relative = path.relative(MULTI_AGENT_WORKSPACE_ROOT, projectPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
