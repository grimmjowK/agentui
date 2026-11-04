import { scanStateDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';

type SessionSynchronizeResult = {
  processedByProvider: Partial<Record<LLMProvider, number>>;
  failures: string[];
};

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 */
export const sessionSynchronizerService = {
  /**
   * Runs every registered provider synchronizer. Each provider succeeds or fails
   * on its own and advances only its own scan cursor, so one failing provider
   * never blocks the others (design D4).
   */
  async synchronizeSessions(): Promise<SessionSynchronizeResult> {
    const scanBoundary = new Date();
    const processedByProvider: Partial<Record<LLMProvider, number>> = {};
    const failures: string[] = [];

    await Promise.all(providerRegistry.listProviders().map(async (provider) => {
      try {
        const since = scanStateDb.getLastScannedAt(provider.id) ?? undefined;
        processedByProvider[provider.id] = await provider.sessionSynchronizer.synchronize(since);
        scanStateDb.updateLastScannedAt(scanBoundary, provider.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${provider.id}: ${reason}`);
        console.warn(`[Sessions] ${provider.id} sync failed; its scan cursor stays put:`, reason);
      }
    }));

    return {
      processedByProvider,
      failures,
    };
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null }> {
    const resolvedProvider = providerRegistry.resolveProvider(provider);
    const sessionId = await resolvedProvider.sessionSynchronizer.synchronizeFile(filePath);
    return {
      provider,
      indexed: Boolean(sessionId),
      sessionId,
    };
  },
};
