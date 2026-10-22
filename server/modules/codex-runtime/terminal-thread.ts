import fs from 'node:fs';

type Thread = { id: string; cwd?: string; parentThreadId?: string | null; source?: unknown };
type Rpc = { request(method: string, params: Record<string, unknown>): Promise<{ thread: Thread }> };

/** Inspect an existing thread without loading it in a throwaway runtime.
 * Only the target TUI should resume it and become its writer.
 */
export async function prepareCodexTerminalThread(rpc: Rpc, threadId: string | null, cwd: string) {
  // metadata-only 读取：不传 includeTurns（默认 false）。paginated thread 的全量 hydration
  // 已 deprecated（0.163.0），切勿在这里加 includeTurns:true，否则会触发分页 API 未实现的报错。
  const { thread } = await rpc.request(threadId ? 'thread/read' : 'thread/start',
    threadId ? { threadId } : { cwd });
  if (threadId && thread.id !== threadId) throw new Error('Codex returned a different thread');
  if (thread.cwd && fs.realpathSync(thread.cwd) !== fs.realpathSync(cwd)) {
    throw new Error('Codex thread belongs to a different project');
  }
  const source = thread.source as {
    subagent?: unknown;
    subAgent?: unknown;
    sub_agent?: unknown;
  } | undefined;
  if (
    thread.parentThreadId
    || (source && typeof source === 'object' && (
      'subagent' in source || 'subAgent' in source || 'sub_agent' in source
    ))
  ) {
    throw new Error(`This is a Codex sub-agent thread and cannot be resumed as a standalone terminal. Open its parent conversation${thread.parentThreadId ? ` (${thread.parentThreadId})` : ''} first. The child history remains available in chat; no different session was opened.`);
  }
  return thread.id;
}
