import fs from 'node:fs';

type ShellSession = {
  cliSessionId?: string;
  provider?: string;
  jsonl_path?: string | null;
};

type SessionLookup = (sessionId: string) => ShellSession | null | undefined;

/** Resolve native resume IDs without trusting stale in-memory Gemini mappings. */
export function createShellSessionLookup(getMemorySession: SessionLookup, getIndexedSession: SessionLookup) {
  return (sessionId: string, requestedProvider?: string): ShellSession | null => {
    const memory = getMemorySession(sessionId);
    const indexed = getIndexedSession(sessionId);
    const provider = indexed?.provider || memory?.provider || requestedProvider;

    if (provider === 'gemini') {
      if (!memory && !indexed) return null;
      const nativeId = memory?.cliSessionId || sessionId;
      const nativeRecord = nativeId === sessionId ? indexed : getIndexedSession(nativeId);
      const transcriptPath = nativeRecord ? nativeRecord.jsonl_path : memory?.jsonl_path;
      const session = { ...memory, ...indexed, provider };
      // Remove the cached ID too: an omitted spread would leave it in the result.
      delete session.cliSessionId;
      try {
        if (typeof transcriptPath === 'string' && transcriptPath.endsWith('.jsonl')
          && fs.statSync(transcriptPath).isFile()) {
          session.cliSessionId = nativeId;
        }
      } catch {
        // Deleted or inaccessible transcripts cannot be resumed.
      }
      return session;
    }

    if (memory?.cliSessionId) return memory;
    if (indexed) return { ...memory, ...indexed, cliSessionId: sessionId };
    return memory || null;
  };
}
