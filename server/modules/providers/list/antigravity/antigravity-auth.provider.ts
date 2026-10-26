import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import { resolveAntigravityExecutablePath } from '@/shared/antigravity-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

const installedCache = new Map<string, boolean>();

export class AntigravityProviderAuth implements IProviderAuth {
  /**
   * Checks whether Antigravity CLI (agy) is available.
   */
  private checkInstalled(): boolean {
    try {
      const cliPath = resolveAntigravityExecutablePath();
      const cached = installedCache.get(cliPath);
      if (cached !== undefined) {
        return cached;
      }
      const result = spawn.sync(cliPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
      const installed = !result.error && result.status === 0;
      if (installed) {
        installedCache.set(cliPath, true);
      }
      return installed;
    } catch {
      return false;
    }
  }

  /**
   * Returns Antigravity CLI installation and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    if (!installed) {
      return {
        installed: false,
        provider: 'antigravity',
        authenticated: false,
        email: null,
        method: null,
        error: 'Antigravity CLI (agy) is not installed. Please install it first.',
      };
    }

    const credentials = await this.checkCredentials();

    return {
      installed: true,
      provider: 'antigravity',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Checks whether Antigravity has cached OAuth credentials. Antigravity reuses
   * the Gemini CLI auth store at ~/.gemini/oauth_creds.json; the agy app-data
   * directory (~/.gemini/antigravity-cli) only holds conversations and settings.
   */
  private async checkCredentials(): Promise<{
    authenticated: boolean;
    email: string | null;
    method: string | null;
    error?: string;
  }> {
    try {
      const credsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
      const content = await readFile(credsPath, 'utf8');
      const creds = readObjectRecord(JSON.parse(content)) ?? {};
      const accessToken = readOptionalString(creds.access_token);
      const refreshToken = readOptionalString(creds.refresh_token);

      if (!accessToken && !refreshToken) {
        return {
          authenticated: false,
          email: null,
          method: null,
          error: 'No valid tokens found in oauth_creds',
        };
      }

      return {
        authenticated: true,
        email: (await this.getActiveAccountEmail()) || 'OAuth Session',
        method: 'credentials_file',
      };
    } catch {
      return {
        authenticated: false,
        email: null,
        method: null,
        error: 'Antigravity CLI not configured',
      };
    }
  }

  /**
   * Reads the active Google account for display from Gemini's account store.
   */
  private async getActiveAccountEmail(): Promise<string | null> {
    try {
      const accPath = path.join(os.homedir(), '.gemini', 'google_accounts.json');
      const content = await readFile(accPath, 'utf8');
      const accounts = readObjectRecord(JSON.parse(content));
      return readOptionalString(accounts?.active) ?? null;
    } catch {
      return null;
    }
  }
}
