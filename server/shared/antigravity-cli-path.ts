import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type ResolutionOptions = {
  platform?: NodeJS.Platform;
  searchPath?: string;
  homeDir?: string;
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

/**
 * Resolves the path to the Antigravity CLI executable (`agy`).
 * Resolution priority:
 * 1. Explicit configured path (process.env.ANTIGRAVITY_CLI_PATH or process.env.AGY_PATH)
 * 2. System PATH
 * 3. Standard fallback locations (~/.local/bin/agy, /opt/homebrew/bin/agy, /usr/local/bin/agy, ~/.gemini/antigravity/bin/agy)
 */
export function resolveAntigravityExecutablePath(
  configuredPath: string | undefined = process.env.ANTIGRAVITY_CLI_PATH || process.env.AGY_PATH,
  options: ResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const searchPath = options.searchPath ?? process.env.PATH ?? '';
  const home = options.homeDir ?? os.homedir();
  const explicit = configuredPath === undefined ? '' : unquote(configuredPath);

  if (configuredPath !== undefined && !explicit) {
    throw new Error('ANTIGRAVITY_CLI_PATH is empty');
  }

  const extensions = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];

  const findOnPath = (command: string) => {
    for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        const candidate = path.resolve(directory, command + extension);
        if (executable(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  };

  if (explicit) {
    const resolved = explicit.includes('/') || explicit.includes('\\')
      ? path.resolve(explicit)
      : findOnPath(explicit);
    if (!resolved || !executable(resolved)) {
      throw new Error(`Antigravity executable is unavailable: ${explicit}`);
    }
    return resolved;
  }

  // Check PATH first
  const onPath = findOnPath('agy');
  if (onPath) {
    return onPath;
  }

  // Check standard user and system locations
  const fallbackDirs = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.gemini', 'antigravity', 'bin'),
  ];

  for (const dir of fallbackDirs) {
    for (const extension of extensions) {
      const candidate = path.resolve(dir, 'agy' + extension);
      if (executable(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    'Antigravity executable (agy) was not found on PATH or standard directories (~/.local/bin, /opt/homebrew/bin, etc.). '
    + 'Please install Antigravity CLI or set ANTIGRAVITY_CLI_PATH.',
  );
}

export function resolveAntigravityConfigRoot(options: { homeDir?: string } = {}): string {
  if (process.env.ANTIGRAVITY_HOME) {
    return path.resolve(process.env.ANTIGRAVITY_HOME);
  }
  const home = options.homeDir ?? os.homedir();
  const cliHome = path.join(home, '.gemini', 'antigravity-cli');
  if (fs.existsSync(cliHome)) {
    return cliHome;
  }
  return path.join(home, '.gemini', 'antigravity');
}

/**
 * Extracts (major, minor, patch) from `agy X.Y.Z` or raw version output.
 */
export function parseAntigravityVersion(raw: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return [major, minor, patch];
}
