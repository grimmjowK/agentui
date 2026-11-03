import { spawn } from 'node:child_process';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const inFlightInstalls = new Map<LLMProvider, Promise<ProviderAuthStatus>>();

function buildInstallShellCommand(provider: LLMProvider, platform: NodeJS.Platform = process.platform): string {
  const isWindows = platform === 'win32';
  if (provider === 'claude') {
    return isWindows
      ? 'npm install -g @anthropic-ai/claude-code'
      : 'npm install -g @anthropic-ai/claude-code || (curl -fsSL https://claude.ai/install.sh | bash)';
  }
  if (provider === 'cursor') {
    return isWindows
      ? "irm 'https://cursor.com/install?win32=true' | iex"
      : 'curl https://cursor.com/install -fsS | bash';
  }
  if (provider === 'codex') {
    return 'npm install -g @openai/codex';
  }
  if (provider === 'gemini') {
    return 'npm install -g @google/gemini-cli';
  }
  return isWindows
    ? 'irm https://antigravity.google/cli/install.ps1 | iex'
    : 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Ignore cleanup errors
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore cleanup errors
    }
  }
}

function runShellInstallCommand(command: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'powershell.exe' : 'bash';
  const args = isWindows
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
    : ['-c', command];

  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      env: { ...process.env, npm_config_loglevel: 'error' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWindows,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      reject(new AppError('CLI installation timed out after 5 minutes.', {
        code: 'CLI_INSTALL_TIMEOUT',
        statusCode: 504,
      }));
    }, INSTALL_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-16384);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16384);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AppError(`Failed to start installer: ${err.message}`, {
        code: 'CLI_INSTALL_FAILED',
        statusCode: 500,
      }));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export const providerAuthService = {
  /**
   * Resolves a provider and returns its installation/authentication status.
   */
  async getProviderAuthStatus(providerName: string): Promise<ProviderAuthStatus> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.auth.getStatus();
  },

  /**
   * Installs the CLI for a provider in the background and returns the updated auth status.
   */
  async installProviderCli(providerName: LLMProvider): Promise<ProviderAuthStatus> {
    if (process.env.VITE_IS_PLATFORM === 'true') {
      throw new AppError('Runtime CLI installation is disabled in platform mode.', {
        code: 'CLI_INSTALL_FORBIDDEN',
        statusCode: 403,
      });
    }

    const existing = inFlightInstalls.get(providerName);
    if (existing) {
      return existing;
    }

    const task = (async () => {
      const command = buildInstallShellCommand(providerName);
      const { code, stdout, stderr } = await runShellInstallCommand(command);

      if (code !== 0) {
        const detail = stderr || stdout || `Installer exited with code ${code}`;
        throw new AppError(`Installation failed: ${detail}`, {
          code: 'CLI_INSTALL_FAILED',
          statusCode: 500,
        });
      }

      const status = await this.getProviderAuthStatus(providerName);
      if (!status.installed) {
        const detail = stderr || stdout || 'CLI executable could not be found after installation.';
        throw new AppError(`Installation completed but CLI is still not detected: ${detail}`, {
          code: 'CLI_INSTALL_NOT_DETECTED',
          statusCode: 500,
        });
      }

      return status;
    })();

    inFlightInstalls.set(providerName, task);
    try {
      return await task;
    } finally {
      inFlightInstalls.delete(providerName);
    }
  },

  /**
   * Returns whether a provider runtime appears installed.
   * Falls back to true if status lookup itself fails so callers preserve the
   * original runtime error instead of replacing it with a status-check failure.
   */
  async isProviderInstalled(providerName: LLMProvider): Promise<boolean> {
    try {
      const status = await this.getProviderAuthStatus(providerName);
      return status.installed;
    } catch {
      return true;
    }
  },

  /**
   * Suffix appended to "CLI is not installed" messages so the failure is
   * self-diagnosable.
   *
   * The message alone is misleading whenever the CLI *is* installed but simply
   * is not on the server process's PATH — the common case for the desktop shell,
   * where a GUI-launched app inherits a minimal PATH and the user can plainly run
   * the same CLI in their terminal. Showing the PATH actually in effect turns
   * "it says it's not installed but it is" into an obvious diagnosis.
   */
  cliLookupPathHint(): string {
    return `\n\nPATH in effect for the server process:\n${process.env.PATH || '(empty)'}`;
  },
};
