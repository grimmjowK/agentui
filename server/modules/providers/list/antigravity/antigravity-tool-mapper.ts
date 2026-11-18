/**
 * Antigravity → 標準工具形狀的唯一映射點（design D13）。
 *
 * 依 agy 1.5.0 實測（docs/fixtures/antigravity/）：
 * - 即時 `step_update`：工具名為 read_file/write_file/edit_file/run_command/search_web；
 *   `tool_info.parameters` 只有摘要欄位（Path、CommandLine、query），不含檔案內容；
 *   失敗時 `state: 'ERROR'` 並帶 `tool_info.error.message`。
 * - 歷史 `transcript.jsonl`：PLANNER_RESPONSE 的 `tool_calls[k]` 對應第 `step_index + 1 + k` 步；
 *   `args` 的每個值都再被 JSON 編碼一次；結果在後續 GENERIC 步驟，失敗時 `status: 'ERROR'`。
 * - 指令失敗時輸出以 `Command exited with code N.` 開頭（N ≠ 0 視為錯誤）。
 *
 * 已知限制：即時路徑沒有檔案內容，Write/Edit 的 diff 在重新載入（讀 transcript）後才完整。
 * init 中列出的 grep_search/find_by_name/list_dir 等工具本次實測未出現，參數形狀未知，
 * 不猜測映射，交給前端通用摘要卡片。
 */
import type { AnyRecord } from '@/shared/types.js';

export type AgyToolCall = { toolName: string; toolInput: AnyRecord };

/** 即時與歷史共用的 toolId 格式。 */
export function agyToolId(stepIndex: unknown): string {
  return `agy_tool_${stepIndex}`;
}

/**
 * id 契約：同一則訊息在即時與歷史中的 id 必須相同，歷史拉取時才能按 id 去重。
 * 文字以 step_index 為準（transcript 與 step_update 共用同一套編號）；tool_use 直接用 toolId。
 */
export function agyTextId(sessionId: string, stepIndex: unknown): string {
  return `agy_${sessionId}_step_${stepIndex}`;
}

/** transcript.jsonl 的 args 值被二次 JSON 編碼；能解就解，解不了保留原值。 */
export function decodeTranscriptArgs(args: unknown): AnyRecord {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const decoded: AnyRecord = {};
  for (const [key, value] of Object.entries(args as AnyRecord)) {
    if (typeof value !== 'string') { decoded[key] = value; continue; }
    try { decoded[key] = JSON.parse(value); } catch { decoded[key] = value; }
  }
  return decoded;
}

const str = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));

/** 把 agy 工具名與參數映射到標準形狀；未登記的工具保留原名與原參數。 */
export function mapAgyTool(name: string, params: AnyRecord): AgyToolCall {
  switch (name) {
    case 'run_command':
      return {
        toolName: 'Bash',
        toolInput: { command: str(params.CommandLine), ...(params.toolSummary ? { description: str(params.toolSummary) } : {}) },
      };
    case 'read_file':
      return { toolName: 'Read', toolInput: { file_path: str(params.Path) } };
    case 'write_file':
      return { toolName: 'Write', toolInput: { file_path: str(params.Path), content: str(params.Content) } };
    case 'edit_file':
      return {
        toolName: 'Edit',
        toolInput: { file_path: str(params.Path), old_string: str(params.Target), new_string: str(params.Replacement) },
      };
    case 'search_web':
      return { toolName: 'WebSearch', toolInput: { query: str(params.query) } };
    default:
      return { toolName: name || 'tool', toolInput: params };
  }
}

const EXIT_CODE_RE = /Command exited with code (-?\d+)/;

/** 去掉 GENERIC 步驟開頭的 `Created At:` / `Completed At:` 時間戳行。 */
export function stripStepHeader(content: string): string {
  return content.replace(/^(?:(?:Created|Completed) At: .*\n)+/, '');
}

/** 依步驟狀態、錯誤欄位或指令結束碼判斷工具是否失敗。 */
export function isAgyToolError(status: unknown, output: string, error?: unknown): boolean {
  if (status === 'ERROR' || error) return true;
  const match = output.match(EXIT_CODE_RE);
  return Boolean(match && Number(match[1]) !== 0);
}

/** 即時 `step_update`（step_type 為 tool）→ tool_use 或 tool_result；其他步驟回傳 null。 */
export function mapAgyStepUpdate(step: AnyRecord): AnyRecord | null {
  if (step?.step_type !== 'tool') return null;
  const toolInfo = (step.tool_info || {}) as AnyRecord;
  const toolId = agyToolId(step.step_index);

  if (step.state === 'ACTIVE') {
    return { kind: 'tool_use', id: toolId, toolId, ...mapAgyTool(String(step.tool_name || toolInfo.name || ''), toolInfo.parameters || {}) };
  }
  if (step.state === 'DONE' || step.state === 'ERROR') {
    const error = toolInfo.error as AnyRecord | undefined;
    const output = error?.message
      ? str(error.message)
      : toolInfo.output == null ? '' : typeof toolInfo.output === 'string' ? toolInfo.output : JSON.stringify(toolInfo.output);
    return { kind: 'tool_result', id: `${toolId}:result`, toolId, content: output, isError: isAgyToolError(step.state, output, error) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// ACP（agy acp）即時事件。實測形狀見 docs/fixtures/antigravity/acp-*.jsonl（agy 1.5.11）：
// - tool_call / tool_call_update 帶 `name`、`args`（與 step_update 的工具名與參數相同）與 `toolCallId`；
// - 完成時結果在 `content[].content.text`（同 `rawOutput.output`），失敗為 `status: 'failed'`；
// - ACP 沒有 step_index，即時 id 以 toolCallId 組成，一輪結束後再以 transcript 對上歷史 id。
// ---------------------------------------------------------------------------

/** ACP 即時工具的 id。 */
export function acpToolId(toolCallId: unknown): string {
  return `agy_acp_${toolCallId}`;
}

function acpToolOutput(update: AnyRecord): string {
  const parts = Array.isArray(update.content) ? update.content : [];
  const texts = parts
    .map((part: AnyRecord) => (part?.content?.type === 'text' ? str(part.content.text) : ''))
    .filter(Boolean);
  if (texts.length) return texts.join('\n');
  const raw = update.rawOutput as AnyRecord | undefined;
  return raw?.output == null ? '' : str(raw.output);
}

/**
 * ACP 的 `session/update`（tool_call / tool_call_update）→ tool_use 或 tool_result；
 * 文字、思考與其他更新由執行層處理（需要累積串流段落），這裡回傳 null。
 */
export function mapAcpUpdate(update: AnyRecord): AnyRecord | null {
  const kind = update?.sessionUpdate;
  if (kind !== 'tool_call' && kind !== 'tool_call_update') return null;
  const toolId = acpToolId(update.toolCallId);
  const status = update.status;
  if (kind === 'tool_call') {
    const args = (update.args ?? update.rawInput ?? {}) as AnyRecord;
    return { kind: 'tool_use', id: toolId, toolId, ...mapAgyTool(str(update.name), args) };
  }
  if (status === 'completed' || status === 'failed') {
    const output = stripStepHeader(acpToolOutput(update));
    const isError = status === 'failed' || isAgyToolError(undefined, output);
    return {
      kind: 'tool_result',
      id: `${toolId}:result`,
      toolId,
      // 被拒絕或取消時 CLI 只給空輸出，補上說明讓卡片看得出原因
      content: output || (status === 'failed' ? 'Tool call was denied or cancelled.' : ''),
      isError,
    };
  }
  return null;
}
