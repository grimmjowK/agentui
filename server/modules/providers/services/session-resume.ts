/**
 * 拼出可以粘贴到任意终端、接着某个会话继续跑的 CLI 命令。
 *
 * 与终端页（shell-websocket.service.ts 的 buildShellCommand）不同：那里跑在应用自己的
 * pty 里，带解析好的绝对路径、`|| claude` 兜底等；这里给人复制到外部终端，用 PATH 上的命令名。
 */

const SAFE_ID = /^[A-Za-z0-9_.:-]+$/;

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const RESUME_ARGS: Record<string, (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  cursor: (id) => `cursor-agent --resume=${id}`,
  antigravity: (id) => `agy --conversation ${id}`,
};

/** nativeId 不合法或 provider 未知时返回 null，前端隐藏「复制 resume 命令」 */
export function buildResumeCommand(
  provider: string,
  nativeId: string,
  projectPath: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const resume = RESUME_ARGS[provider];
  if (!resume || !SAFE_ID.test(nativeId)) return null;
  if (!projectPath) return resume(nativeId);
  return platform === 'win32'
    ? `Set-Location ${quotePowerShell(projectPath)}; ${resume(nativeId)}`
    : `cd ${quotePosix(projectPath)} && ${resume(nativeId)}`;
}
