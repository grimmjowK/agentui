import fs from 'node:fs';

const DEFAULT_CODEX_COMMAND = 'codex';

const MAC_APP_CODEX_PATHS = [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
] as const;

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 解析 Codex CLI 可执行文件路径。
 *
 * 优先级：
 * 1. 显式传入或环境变量 `CODEX_CLI_PATH`
 * 2. macOS 桌面端 App 内置二进制（ChatGPT.app / Codex.app，版本通常高于 npm 公开包）
 * 3. 系统 PATH 中的 `codex`
 */
export function resolveCodexExecutablePath(
  configuredPath: string | undefined = process.env.CODEX_CLI_PATH,
): string {
  if (configuredPath) {
    const normalized = stripWrappingQuotes(configuredPath);
    if (normalized) {
      return normalized;
    }
  }

  if (process.platform === 'darwin') {
    for (const candidate of MAC_APP_CODEX_PATHS) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return DEFAULT_CODEX_COMMAND;
}
