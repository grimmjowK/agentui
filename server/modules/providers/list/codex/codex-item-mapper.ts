/**
 * Codex → 標準工具形狀的唯一映射點（design D1）。
 *
 * 即時路徑（app-server `ThreadItem`）與歷史路徑（rollout JSONL）都經過這裡，
 * 輸出相同的 `MappedMessage`，呼叫端再補上 provider/sessionId/timestamp。
 * 映射目標沿用前端既有的 Claude 工具形狀（Bash/Edit/Write/TodoWrite…）。
 */
import type { ThreadItem, TurnPlanUpdatedNotification } from '@/modules/codex-runtime/index.js';
import type { AnyRecord, MessageKind } from '@/shared/types.js';

export type MappedMessage = { kind: MessageKind } & AnyRecord;

export type RolloutMappingContext = {
  sessionId?: string | null;
  lineIndex?: number;
};

function deterministicRolloutId(context?: RolloutMappingContext): string | undefined {
  if (!context?.sessionId || context.lineIndex === undefined) {
    return undefined;
  }
  return `codex_${context.sessionId}_${context.lineIndex}`;
}

/** 檔案變更的中間形狀：即時 `FileUpdateChange` 與歷史 `apply_patch` 都先收斂到這裡。 */
export type CodexFileChange = {
  path: string;
  kind: 'add' | 'update' | 'delete';
  movePath?: string | null;
  diff: string;
};

const COMPACT_BOUNDARY_TEXT = 'Context compacted';

/** 從 unified diff 拆出 old/new 字串；上下文行會丟失（已知上限，見 design Risks）。 */
export function splitUnifiedDiff(diff: string): { oldString: string; newString: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith('+')) newLines.push(line.slice(1));
  }
  return { oldString: oldLines.join('\n'), newString: newLines.join('\n') };
}

/** 新增/刪除檔案的 diff 可能是 `+`/`-` 前綴的 patch，也可能是原始內容。 */
function stripPatchPrefix(text: string, prefix: '+' | '-'): string {
  const lines = String(text || '').split('\n');
  const body = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  if (body.length > 0 && body.every((line) => line.startsWith(prefix))) {
    return body.map((line) => line.slice(1)).join('\n');
  }
  return text;
}

/** 解析 `apply_patch` 文本，支援 Add/Update/Delete/Move 多段（也容忍多個 Begin/End 區塊）。 */
export function parseApplyPatch(patch: string): CodexFileChange[] {
  const changes: CodexFileChange[] = [];
  let current: (CodexFileChange & { lines: string[] }) | null = null;
  const flush = () => {
    if (current) {
      const { lines, ...change } = current;
      changes.push({ ...change, diff: lines.join('\n') });
    }
    current = null;
  };

  for (const line of String(patch || '').split('\n')) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) {
      flush();
      const kind = header[1].toLowerCase() as CodexFileChange['kind'];
      current = { path: header[2].trim(), kind, movePath: null, diff: '', lines: [] };
      continue;
    }
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move && current) {
      current.movePath = move[1].trim();
      continue;
    }
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch') || line.startsWith('*** End of File')) {
      continue;
    }
    current?.lines.push(line);
  }
  flush();
  return changes;
}

/** 把一個檔案變更映射成 `Write`（新增）或 `Edit`（更新/刪除/改名）。 */
export function fileChangeToTool(change: CodexFileChange): { toolName: string; toolInput: AnyRecord } {
  if (change.kind === 'add') {
    return { toolName: 'Write', toolInput: { file_path: change.path, content: stripPatchPrefix(change.diff, '+') } };
  }
  if (change.kind === 'delete') {
    return {
      toolName: 'Edit',
      toolInput: { file_path: change.path, old_string: stripPatchPrefix(change.diff, '-'), new_string: '', changeKind: 'delete' },
    };
  }
  const { oldString, newString } = splitUnifiedDiff(change.diff);
  return {
    toolName: 'Edit',
    toolInput: {
      file_path: change.path,
      old_string: oldString,
      new_string: newString,
      ...(change.movePath ? { changeKind: 'move', move_path: change.movePath } : {}),
    },
  };
}

function normalizeTodoStatus(status: unknown): string {
  if (status === 'inProgress' || status === 'in-progress') return 'in_progress';
  return typeof status === 'string' ? status : 'pending';
}

/** `update_plan` 的 `plan: [{step,status}]`、`steps: [{name,status}]`（可能是 JSON 字串）都轉成 TodoWrite。 */
export function planToTodos(plan: unknown): Array<{ content: string; status: string }> {
  let list = plan;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((step): step is AnyRecord => Boolean(step) && typeof step === 'object')
    .map((step) => ({
      content: String(step.step ?? step.name ?? step.content ?? ''),
      status: normalizeTodoStatus(step.status),
    }));
}

function parseArgs(raw: unknown): AnyRecord {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as AnyRecord;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * app-server 的 commandExecution.command 是包過 shell 的形式（`/bin/zsh -lc 'ls src'`），
 * rollout 的 exec_command 則是原始指令；拆掉外層讓兩條路徑顯示相同的指令。
 */
export function unwrapShellCommand(command: string): string {
  const match = String(command || '').match(/^(?:\S*\/)?(?:ba|z)?sh -l?c (.+)$/s);
  if (!match) return command;
  const inner = match[1].trim();
  if (inner.length >= 2 && inner.startsWith("'") && inner.endsWith("'")) {
    return inner.slice(1, -1).replace(/'\\''/g, "'");
  }
  return inner;
}

/** 依結束碼或輸出文字判斷指令是否失敗（rollout 沒有結構化的 exit code 欄位）。 */
export function isErrorOutput(payload: AnyRecord): boolean {
  if (payload.is_error || payload.isError || payload.status === 'failed') return true;
  for (const code of [payload.exit_code, payload.exitCode]) {
    if (typeof code === 'number' && code !== 0) return true;
  }
  const output = payload.output;
  return typeof output === 'string' && (
    /^exit code:?\s*[1-9]\d*/im.test(output)
    || /failed \(exit\s*[1-9]\d*\)/i.test(output)
    || /process exited with code [1-9]\d*/i.test(output)
  );
}

/** 函式型工具（指令、計畫、終端輸入、js）→ 標準形狀；未登記的保留原名交給降級卡片。 */
function mapFunctionTool(name: string, args: AnyRecord): { toolName: string; toolInput: unknown } {
  switch (name) {
    case 'exec_command':
    case 'shell_command':
    case 'shell':
    case 'exec': {
      const cmd = args.cmd ?? args.command;
      const command = Array.isArray(cmd) ? cmd.join(' ') : cmd;
      return { toolName: 'Bash', toolInput: { command: stringify(command), ...(args.workdir ? { cwd: args.workdir } : {}) } };
    }
    case 'write_stdin':
      return { toolName: 'TerminalInput', toolInput: { session_id: args.session_id, chars: args.chars ?? '' } };
    case 'js':
      return { toolName: 'CodeRun', toolInput: { title: args.title, code: stringify(args.code) } };
    case 'update_plan':
      return { toolName: 'TodoWrite', toolInput: { todos: planToTodos(args.plan ?? args.steps) } };
    case 'web_search':
      return { toolName: 'WebSearch', toolInput: { query: stringify(args.query) } };
    default:
      return { toolName: name || 'Unknown', toolInput: args };
  }
}

function splitFileChanges(baseId: string, changes: CodexFileChange[]): MappedMessage[] {
  return changes.map((change, index) => {
    const splitId = `${baseId}:${index}`;
    return { kind: 'tool_use', id: splitId, toolId: splitId, ...fileChangeToTool(change) };
  });
}

// ---------------------------------------------------------------------------
// 即時路徑：app-server ThreadItem
// ---------------------------------------------------------------------------

/** webSearch 的 action 依種類帶 query 或 url。 */
function webSearchTarget(action: Extract<ThreadItem, { type: 'webSearch' }>['action']): string {
  if (action && 'query' in action && action.query) return action.query;
  if (action && 'url' in action && action.url) return action.url;
  return '';
}

/**
 * 映射 `item/started` / `item/completed` 的 ThreadItem。
 * `agentMessage`、`userMessage` 由呼叫端自行處理（串流相關），這裡回傳空陣列。
 */
export function mapThreadItem(item: ThreadItem, phase: 'started' | 'completed'): MappedMessage[] {
  const isCompleted = phase === 'completed';
  const id = String(item.id ?? '');

  switch (item.type) {
    case 'agentMessage':
    case 'userMessage':
    case 'hookPrompt':
      return [];

    case 'commandExecution': {
      const isError = isCompleted && (item.status === 'failed' || item.status === 'declined'
        || (typeof item.exitCode === 'number' && item.exitCode !== 0));
      return [{
        kind: 'tool_use', id, toolId: id, toolName: 'Bash',
        toolInput: { command: unwrapShellCommand(item.command), cwd: item.cwd },
        ...(isCompleted ? {
          toolResult: { content: item.aggregatedOutput || (isError ? `Exit code ${item.exitCode ?? 1}` : ''), isError },
        } : {}),
      }];
    }

    case 'fileChange': {
      const isError = isCompleted && (item.status === 'failed' || item.status === 'declined');
      const changes: CodexFileChange[] = (Array.isArray(item.changes) ? item.changes : []).map((change: AnyRecord) => ({
        path: String(change.path ?? ''),
        kind: (change.kind?.type ?? 'update') as CodexFileChange['kind'],
        movePath: change.kind?.move_path ?? null,
        diff: String(change.diff ?? ''),
      }));
      return splitFileChanges(id, changes).map((message) => ({
        ...message,
        ...(isCompleted ? { toolResult: { content: isError ? `File change ${item.status}` : '', isError } } : {}),
      }));
    }

    case 'mcpToolCall': {
      const isError = Boolean(item.error) || (isCompleted && item.status === 'failed');
      const content = item.error ? (item.error.message ?? stringify(item.error)) : stringify(item.result);
      return [{
        kind: 'tool_use', id, toolId: id, toolName: `${item.server}/${item.tool}`, toolInput: item.arguments,
        ...(isCompleted ? { toolResult: { content, isError } } : {}),
      }];
    }

    case 'plan':
      // plan 模式產出的是自由文字計畫（非步驟清單），以計畫卡片呈現。
      return [{
        kind: 'tool_use', id, toolId: id, toolName: 'ExitPlanMode', toolInput: { plan: String(item.text ?? '') },
        ...(isCompleted ? { toolResult: { content: '', isError: false } } : {}),
      }];

    case 'webSearch':
      return [{
        kind: 'tool_use', id, toolId: id, toolName: 'WebSearch',
        toolInput: { query: item.query || webSearchTarget(item.action) },
        ...(isCompleted ? { toolResult: { content: '', isError: false } } : {}),
      }];

    case 'reasoning': {
      if (!isCompleted) return [];
      const parts = Array.isArray(item.summary) && item.summary.length ? item.summary : item.content;
      const content = Array.isArray(parts) ? parts.filter(Boolean).join('\n') : '';
      return content.trim() ? [{ kind: 'thinking', id, content }] : [];
    }

    case 'contextCompaction':
      return isCompleted
        ? [{ kind: 'text', id, role: 'assistant', content: COMPACT_BOUNDARY_TEXT, isCompactBoundary: true }]
        : [];

    case 'dynamicToolCall':
      return [{
        kind: 'tool_use', id, toolId: id, toolName: String(item.tool || item.type), toolInput: item.arguments,
        ...(isCompleted ? { toolResult: { content: stringify(item.contentItems), isError: item.success === false } } : {}),
      }];

    default: {
      const { id: _id, type, ...rest } = item;
      return [{
        kind: 'tool_use', id, toolId: id, toolName: String(type || 'Unknown'), toolInput: rest,
        ...(isCompleted ? { toolResult: { content: '', isError: false } } : {}),
      }];
    }
  }
}

/** `turn/plan/updated` 通知 → TodoWrite；同一輪重複更新共用同一個 id，前端按 id 覆蓋。 */
export function mapPlanUpdate(params: Pick<TurnPlanUpdatedNotification, 'turnId' | 'plan'>): MappedMessage[] {
  const id = `plan:${params.turnId ?? 'unknown'}`;
  return [{
    kind: 'tool_use', id, toolId: id, toolName: 'TodoWrite',
    toolInput: { todos: planToTodos(params.plan) },
    toolResult: { content: '', isError: false },
  }];
}

// ---------------------------------------------------------------------------
// 歷史路徑：rollout JSONL
// ---------------------------------------------------------------------------

/**
 * 映射一筆 rollout 條目的工具相關部分（呼叫、輸出、推理、網頁搜尋、壓縮）。
 * `callIdToSplitIdsMap` 記錄被拆分的 `apply_patch`，讓後續輸出展開成多筆 `tool_result`。
 * 非工具條目（使用者/助手訊息、token 計數等）回傳空陣列，由呼叫端處理。
 */
export function mapRolloutEntry(
  entry: AnyRecord,
  callIdToSplitIdsMap: Map<string, string[]>,
  context?: RolloutMappingContext,
): MappedMessage[] {
  const fallbackId = deterministicRolloutId(context);
  if (entry.type === 'compacted') {
    return [{
      kind: 'text',
      ...(fallbackId ? { id: fallbackId } : {}),
      role: 'assistant',
      content: COMPACT_BOUNDARY_TEXT,
      isCompactBoundary: true,
    }];
  }
  if (entry.type !== 'response_item' || !entry.payload) return [];
  const payload = entry.payload as AnyRecord;
  const callId = String(payload.call_id ?? payload.id ?? '');

  switch (payload.type) {
    case 'reasoning': {
      const content = Array.isArray(payload.summary)
        ? payload.summary.map((part: AnyRecord) => part?.text).filter(Boolean).join('\n')
        : '';
      return content.trim()
        ? [{
            kind: 'thinking',
            id: typeof payload.id === 'string' && payload.id ? payload.id : fallbackId,
            content,
          }]
        : [];
    }

    case 'function_call': {
      const args = parseArgs(payload.arguments);
      // 舊版以 function_call 送 apply_patch：arguments.command = ['apply_patch', patch]
      if (payload.name === 'apply_patch') {
        const patch = Array.isArray(args.command) ? args.command.at(-1) : args.input ?? args.patch;
        return mapPatch(callId, String(patch ?? ''), callIdToSplitIdsMap);
      }
      return [{ kind: 'tool_use', toolId: callId, ...mapFunctionTool(String(payload.name ?? ''), args) }];
    }

    case 'custom_tool_call': {
      const input = String(payload.input ?? '');
      if (payload.name === 'apply_patch') return mapPatch(callId, input, callIdToSplitIdsMap);
      // 0.143 起的 code mode：`exec` 的 input 是 JS 程式碼（內部再呼叫 tools.exec_command），不是 shell 指令。
      if (payload.name === 'exec') {
        return [{ kind: 'tool_use', toolId: callId, toolName: 'CodeRun', toolInput: { code: input } }];
      }
      return [{ kind: 'tool_use', toolId: callId, toolName: String(payload.name || 'custom_tool'), toolInput: input }];
    }

    case 'function_call_output':
    case 'custom_tool_call_output': {
      const content = stringify(payload.output);
      const isError = isErrorOutput(payload);
      const toolIds = callIdToSplitIdsMap.get(callId) ?? [callId];
      return toolIds.map((toolId) => ({ kind: 'tool_result', toolId, content, isError }));
    }

    case 'web_search_call':
      return [{
        kind: 'tool_use', toolId: callId || `web_search:${entry.timestamp}`, toolName: 'WebSearch',
        toolInput: { query: payload.action?.query || payload.action?.url || payload.query || '' },
        toolResult: { content: '', isError: payload.status === 'failed' },
      }];

    default:
      return [];
  }
}

function mapPatch(callId: string, patch: string, callIdToSplitIdsMap: Map<string, string[]>): MappedMessage[] {
  const changes = parseApplyPatch(patch);
  if (changes.length === 0) {
    return [{ kind: 'tool_use', toolId: callId, toolName: 'apply_patch', toolInput: { patch } }];
  }
  const messages = splitFileChanges(callId, changes);
  callIdToSplitIdsMap.set(callId, messages.map((message) => String(message.toolId)));
  // 歷史 tool_use 的 id 由呼叫端以 toolId 填入（`${callId}:${index}`，與即時拆分訊息同 id）
  return messages.map(({ id: _id, ...rest }) => rest);
}
