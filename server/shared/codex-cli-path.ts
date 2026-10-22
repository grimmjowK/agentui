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

/**
 * 最低已验证的 app-server 协议版本。
 * 协议基线实测于 0.155.0-alpha.9（见 docs/codex-runtime-protocol.md）；达到或高于此版本
 * 视为已验证，低于此版本仍尝试运行但标记为未验证并向用户告警。比较时忽略 `-alpha.N` 等
 * 预发布后缀，只看 major.minor.patch。
 */
const MIN_VERIFIED_CODEX_VERSION: readonly [number, number, number] = [0, 155, 0];

/** 从 `codex-cli X.Y.Z[-prerelease]` 中提取可比较的 (major, minor, patch)；无法解析返回 null。 */
export function parseCodexVersion(raw: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * 判定运行协议兼容状态：
 * - `unsupported`：版本号无法解析，视为不支持（queryCodex 会拒绝进入聊天）。
 * - `unverified`：版本可解析但低于最低已验证版本，或平台未经协议实测；仍尝试运行并告警。
 * - `protocol-tested`：版本达到最低已验证版本且平台为 darwin。
 */
export function resolveCodexCapabilityStatus(
  rawVersion: string,
  platform: NodeJS.Platform = process.platform,
): 'protocol-tested' | 'unverified' | 'unsupported' {
  const parsed = parseCodexVersion(rawVersion);
  if (!parsed) return 'unsupported';
  if (platform !== 'darwin') return 'unverified';
  return compareVersion(parsed, MIN_VERIFIED_CODEX_VERSION) >= 0 ? 'protocol-tested' : 'unverified';
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
      status: resolveCodexCapabilityStatus(cached.version),
      additionalPermissions: false,
    },
    source: process.env.CODEX_CLI_PATH !== undefined ? 'configured'
      : MAC_APP_CODEX_PATHS.includes(executablePath) ? 'app' : 'path',
  };
}
