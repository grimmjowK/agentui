import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAC_APP_CODEX_PATHS = [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
];

type ResolutionOptions = {
  platform?: NodeJS.Platform;
  searchPath?: string;
  appPaths?: string[];
};

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(".*"|'.*')$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function executable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Resolve once using the same precedence for chat, PTY, auth and model discovery. */
export function resolveCodexExecutablePath(
  configuredPath: string | undefined = process.env.CODEX_CLI_PATH,
  options: ResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const searchPath = options.searchPath ?? process.env.PATH ?? '';
  const explicit = configuredPath === undefined ? '' : unquote(configuredPath);
  if (configuredPath !== undefined && !explicit) throw new Error('CODEX_CLI_PATH is empty');
  const findOnPath = (command: string) => {
    const extensions = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
    for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        const candidate = path.resolve(directory, command + extension);
        if (executable(candidate)) return candidate;
      }
    }
    return null;
  };
  if (explicit) {
    const resolved = explicit.includes('/') || explicit.includes('\\')
      ? path.resolve(explicit) : findOnPath(explicit);
    if (!resolved || !executable(resolved)) throw new Error(`Codex executable is unavailable: ${explicit}`);
    return resolved;
  }
  if (platform === 'darwin') {
    for (const candidate of options.appPaths ?? MAC_APP_CODEX_PATHS) {
      if (executable(candidate)) return path.resolve(candidate);
    }
  }
  const resolved = findOnPath('codex');
  if (!resolved) throw new Error('Codex executable was not found on PATH');
  return resolved;
}

export function resolveCodexConfigRoot(): string {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

const versions = new Map<string, { stamp: string; version: string }>();

export function getCodexRuntimeInfo() {
  const executablePath = resolveCodexExecutablePath();
  const stat = fs.statSync(executablePath);
  const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  let cached = versions.get(executablePath);
  if (!cached || cached.stamp !== stamp) {
    const version = execFileSync(executablePath, ['--version'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    }).trim();
    cached = { stamp, version };
    versions.set(executablePath, cached);
  }
  return {
    executablePath,
    version: cached.version,
    configRoot: resolveCodexConfigRoot(),
    capabilities: {
      status: cached.version === 'codex-cli 0.155.0-alpha.9' && process.platform === 'darwin' ? 'protocol-tested' : 'unverified',
      additionalPermissions: false,
    },
    source: process.env.CODEX_CLI_PATH !== undefined ? 'configured'
      : MAC_APP_CODEX_PATHS.includes(executablePath) ? 'app' : 'path',
  };
}
