import type { IProviderRuntime, ProviderRuntimeWriter } from '@/shared/interfaces.js';

export type Script = (ctx: {
  prompt: string;
  options: Record<string, unknown>;
  writer: ProviderRuntimeWriter;
  aborted: () => boolean;
  sessionId: string;
}) => Promise<void>;

/** 可腳本化的假 runtime：記錄呼叫，abort 後停止並送 complete(aborted)。 */
export function createMockRuntime(script: Script) {
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  const abortedSessions = new Set<string>();
  let counter = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const runtime: IProviderRuntime = {
    async start(command, options, writer) {
      calls.push({ prompt: command, options });
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const sessionId = typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : `s${++counter}`;
      abortedSessions.delete(sessionId); // 續接的新一輪不沿用上一輪的中止
      if (!options.sessionId) writer.send({ kind: 'session_created', newSessionId: sessionId, sessionId });
      try {
        await script({ prompt: command, options, writer, aborted: () => abortedSessions.has(sessionId), sessionId });
        writer.send({ kind: 'complete', exitCode: 0, sessionId, aborted: abortedSessions.has(sessionId) });
      } finally {
        concurrent -= 1;
      }
    },
    async abort(sessionId) {
      abortedSessions.add(sessionId);
      return { ok: true, emitsTerminal: false };
    },
    isActive: () => false,
    reconnect: () => false,
    listActive: () => [],
  };
  return { runtime, calls, get maxConcurrent() { return maxConcurrent; } };
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** 送出文字後等待中止或結束 */
export const say = (text: string, holdMs = 0): Script => async ({ writer, aborted, sessionId }) => {
  writer.send({ kind: 'stream_delta', content: text, sessionId });
  const until = Date.now() + holdMs;
  while (Date.now() < until && !aborted()) await tick(2);
  if (!aborted()) writer.send({ kind: 'text', role: 'assistant', content: text, sessionId });
};
