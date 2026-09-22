import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';

export const providerAuthService = {
  /**
   * Resolves a provider and returns its installation/authentication status.
   */
  async getProviderAuthStatus(providerName: string): Promise<ProviderAuthStatus> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.auth.getStatus();
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
