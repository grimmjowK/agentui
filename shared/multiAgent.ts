/**
 * 多 Agent（聊天室 / 工作流）前後端共用型別與校驗（multi-agent-workspace design D2）。
 */
import { isLLMProvider, PROVIDER_INFO, type LLMProvider, type PermissionMode } from './providers.js';

export type MultiAgentKind = 'chatroom' | 'workflow';

/**
 * 工作流節點。`agent`（預設）呼叫模型執行；`approval` 暫停整個執行，等使用者在畫布上按核准／駁回。
 * 核准節點不需要 provider / model，核准時的備註會成為它的輸出，傳給下游。
 */
export type WorkflowNode = {
  id: string;
  title: string;
  instruction: string;
  /** 未設定視為 agent */
  type?: 'agent' | 'approval';
  provider?: LLMProvider;
  model?: string;
  /** 未設定時用 provider 預設權限模式 */
  permissionMode?: PermissionMode;
  dependsOn: string[];
};

export const isApprovalNode = (node: WorkflowNode): boolean => node.type === 'approval';
export type WorkflowDef = { nodes: WorkflowNode[] };

export type ChatMember = {
  id: string;
  name: string;
  persona: string;
  provider: LLMProvider;
  model: string;
  /** 未設定時用 MEMBER_DEFAULT_PERMISSION_MODE */
  permissionMode?: PermissionMode;
  color?: string;
};
export type ChatRules = {
  text: string;
  /** 舊版相容欄位（已移除硬截斷） */
  maxReplyChars?: number;
  allowAiMentions: boolean;
  maxAiRepliesPerTurn: number;
  unmentionedBehavior: 'all' | 'none';
};
export type ChatroomDef = { members: ChatMember[]; rules: ChatRules };

export type MultiAgentDefinition = WorkflowDef | ChatroomDef;

export type MultiAgent = {
  id: string;
  kind: MultiAgentKind;
  name: string;
  definition: MultiAgentDefinition | null;
  definitionVersion: number;
  /** promptVersion：該會話最後收到的建立器說明版本 */
  builderSession: { provider: LLMProvider; sessionId: string; promptVersion?: number } | null;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * waiting_approval：tool 審批（模型要調用工具，等全域審批收件匣處理）
 * waiting_confirmation：人工確認節點，等使用者在畫布上核准／駁回
 * waiting_input：使用者在聊天頁中斷節點，等待新指示、以目前輸出完成或標記失敗
 */
export type NodeRunState = 'pending' | 'running' | 'waiting_approval' | 'waiting_confirmation' | 'waiting_input' | 'succeeded' | 'failed' | 'skipped';
export type NodeRunStatus = {
  state: NodeRunState;
  progress: number;
  output?: string;
  error?: string;
  /** 節點的 provider sessionId；前端用它找出該節點的工具審批請求 */
  sessionId?: string;
};
export type RunStatus = 'running' | 'stopping' | 'succeeded' | 'failed' | 'stopped' | 'interrupted';
export type WorkflowRun = {
  id: string;
  multiAgentId: string;
  status: RunStatus;
  definitionVersion: number;
  definition: WorkflowDef;
  nodeStates: Record<string, NodeRunStatus>;
  /** 啟動時輸入，附在沒有依賴的節點提示前 */
  startInput: string | null;
  isArchived?: boolean;
  startedAt: string;
  finishedAt: string | null;
};

export type ChatThread = {
  id: string;
  multiAgentId: string;
  title: string;
  isArchived?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessageStatus = 'queued' | 'streaming' | 'done' | 'error';
export type ChatMessage = {
  id: string;
  multiAgentId: string;
  threadId?: string;
  turnId: string | null;
  seq: number;
  authorKind: 'user' | 'member' | 'system';
  memberId: string | null;
  author: { name: string; provider?: LLMProvider; model?: string; color?: string } | null;
  content: string;
  status: ChatMessageStatus;
  finishReason: string | null;
  createdAt: string;
};

export const MAX_WORKFLOW_NODES = 12;
export const MAX_CHAT_MEMBERS = 8;
export const MAX_REPLY_CHARS_RANGE = [1, 8000] as const;
export const MAX_AI_REPLIES_RANGE = [1, 32] as const;
export const EVERYONE_NAME = '所有人';
export const EVERYONE_ALIASES = ['所有人', 'all', 'everyone'];

/** 成員預設採各 provider 最保守的現有模式（design D6） */
export const MEMBER_DEFAULT_PERMISSION_MODE: Record<LLMProvider, PermissionMode> = {
  claude: 'plan',
  cursor: 'plan',
  codex: 'default',
  antigravity: 'default',
};

export function defaultChatRules(memberCount: number): ChatRules {
  return {
    text: '',
    allowAiMentions: false,
    maxAiRepliesPerTurn: Math.max(1, Math.min(MAX_AI_REPLIES_RANGE[1], memberCount)),
    unmentionedBehavior: 'all',
  };
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isIntIn = (v: unknown, [min, max]: readonly [number, number]) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function checkPermissionMode(errors: string[], label: string, provider: LLMProvider, mode: unknown) {
  if (mode === undefined) return;
  if (!PROVIDER_INFO[provider].permissionModes.includes(mode as PermissionMode)) {
    errors.push(`${label}: 權限模式 ${String(mode)} 不適用於 ${provider}`);
  }
}

/**
 * Kahn 拓樸分層。回傳每層的節點 id；有環或缺失依賴時回傳 null。
 */
export function layerWorkflow(def: WorkflowDef): string[][] | null {
  const ids = new Set(def.nodes.map((n) => n.id));
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const node of def.nodes) {
    if (node.dependsOn.some((dep) => !ids.has(dep))) return null;
    indegree.set(node.id, new Set(node.dependsOn).size);
    for (const dep of new Set(node.dependsOn)) {
      children.set(dep, [...(children.get(dep) ?? []), node.id]);
    }
  }
  const layers: string[][] = [];
  let current = def.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  let seen = 0;
  while (current.length) {
    layers.push(current);
    seen += current.length;
    const next: string[] = [];
    for (const id of current) {
      for (const child of children.get(id) ?? []) {
        const left = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, left);
        if (left === 0) next.push(child);
      }
    }
    current = next;
  }
  return seen === def.nodes.length ? layers : null;
}

/**
 * 結構校驗。模型是否有效另以 validateModels 注入清單校驗（清單來自 providerModelsService）。
 */
export function validateDefinition(kind: MultiAgentKind, def: unknown): string[] {
  const errors: string[] = [];
  if (!def || typeof def !== 'object') return ['定義必須是物件'];

  if (kind === 'workflow') {
    const nodes = (def as WorkflowDef).nodes;
    if (!Array.isArray(nodes)) return ['nodes 必須是陣列'];
    if (nodes.length < 1 || nodes.length > MAX_WORKFLOW_NODES) errors.push(`節點數須為 1–${MAX_WORKFLOW_NODES}`);
    const ids = new Set<string>();
    nodes.forEach((n, i) => {
      const label = `節點 ${n?.id ?? i + 1}`;
      if (!n || typeof n !== 'object') { errors.push(`${label}: 格式錯誤`); return; }
      if (!isNonEmptyString(n.id)) errors.push(`${label}: 缺少 id`);
      else if (ids.has(n.id)) errors.push(`${label}: id 重複`);
      else ids.add(n.id);
      if (!isNonEmptyString(n.title)) errors.push(`${label}: 缺少標題`);
      if (!isNonEmptyString(n.instruction)) errors.push(`${label}: 缺少執行內容`);
      if (n.type !== undefined && n.type !== 'agent' && n.type !== 'approval') {
        errors.push(`${label}: type 必須是 agent 或 approval`);
      }
      if (isApprovalNode(n as WorkflowNode)) {
        if (n.provider !== undefined || n.model !== undefined) errors.push(`${label}: 人工確認節點不需要 provider / model`);
      } else if (!isLLMProvider(n.provider)) {
        errors.push(`${label}: provider 不合法`);
      } else {
        checkPermissionMode(errors, label, n.provider, n.permissionMode);
        if (!isNonEmptyString(n.model)) errors.push(`${label}: 缺少模型`);
      }
      if (!Array.isArray(n.dependsOn) || n.dependsOn.some((d) => typeof d !== 'string')) {
        errors.push(`${label}: dependsOn 必須是字串陣列`);
      }
    });
    if (!errors.length) {
      for (const n of nodes) {
        for (const dep of n.dependsOn) if (!ids.has(dep)) errors.push(`節點 ${n.id}: 依賴 ${dep} 不存在`);
      }
      if (!errors.length && !layerWorkflow(def as WorkflowDef)) errors.push('節點依賴存在環');
    }
    return errors;
  }

  const { members, rules } = def as ChatroomDef;
  if (!Array.isArray(members)) return ['members 必須是陣列'];
  if (members.length < 1 || members.length > MAX_CHAT_MEMBERS) errors.push(`成員數須為 1–${MAX_CHAT_MEMBERS}`);
  const ids = new Set<string>();
  const names = new Set<string>();
  members.forEach((m, i) => {
    const label = `成員 ${m?.name ?? i + 1}`;
    if (!m || typeof m !== 'object') { errors.push(`${label}: 格式錯誤`); return; }
    if (!isNonEmptyString(m.id)) errors.push(`${label}: 缺少 id`);
    else if (ids.has(m.id)) errors.push(`${label}: id 重複`);
    else ids.add(m.id);
    if (!isNonEmptyString(m.name)) errors.push(`${label}: 缺少名稱`);
    else {
      const key = m.name.trim().toLowerCase();
      if (EVERYONE_ALIASES.includes(key)) errors.push(`${label}: 名稱不可為保留字「${EVERYONE_NAME}」`);
      else if (/[\s@]/.test(m.name.trim())) errors.push(`${label}: 名稱不可含空白或 @`);
      else if (names.has(key)) errors.push(`${label}: 名稱重複`);
      names.add(key);
    }
    if (typeof m.persona !== 'string') errors.push(`${label}: 人設必須是字串`);
    if (!isLLMProvider(m.provider)) errors.push(`${label}: provider 不合法`);
    else checkPermissionMode(errors, label, m.provider, m.permissionMode);
    if (!isNonEmptyString(m.model)) errors.push(`${label}: 缺少模型`);
  });
  if (!rules || typeof rules !== 'object') {
    errors.push('缺少群聊規則');
    return errors;
  }
  if (typeof rules.text !== 'string') errors.push('群規文字必須是字串');
  if (rules.maxReplyChars !== undefined && rules.maxReplyChars !== null && !isIntIn(rules.maxReplyChars, MAX_REPLY_CHARS_RANGE)) {
    errors.push(`每則回覆最大字數須為 ${MAX_REPLY_CHARS_RANGE[0]}–${MAX_REPLY_CHARS_RANGE[1]} 的整數`);
  }
  if (!isIntIn(rules.maxAiRepliesPerTurn, MAX_AI_REPLIES_RANGE)) {
    errors.push(`每輪 AI 回覆上限須為 ${MAX_AI_REPLIES_RANGE[0]}–${MAX_AI_REPLIES_RANGE[1]} 的整數`);
  }
  if (typeof rules.allowAiMentions !== 'boolean') errors.push('allowAiMentions 必須是布林值');
  if (rules.unmentionedBehavior !== 'all' && rules.unmentionedBehavior !== 'none') {
    errors.push('unmentionedBehavior 必須是 all 或 none');
  }
  return errors;
}

/** 以注入的模型清單校驗每個節點／成員的模型。清單缺該 provider 時視為暫時無法驗證。 */
export function validateModels(
  kind: MultiAgentKind,
  def: MultiAgentDefinition,
  modelsByProvider: Partial<Record<LLMProvider, string[]>>,
): string[] {
  const items = kind === 'workflow'
    ? (def as WorkflowDef).nodes.filter((n) => !isApprovalNode(n))
      .map((n) => ({ label: `節點 ${n.id}`, provider: n.provider as LLMProvider, model: n.model as string }))
    : (def as ChatroomDef).members.map((m) => ({ label: `成員 ${m.name}`, provider: m.provider, model: m.model }));
  const errors: string[] = [];
  for (const item of items) {
    const list = modelsByProvider[item.provider];
    if (!list) errors.push(`${item.label}: 暫時無法驗證 ${item.provider} 的模型清單`);
    else if (!list.includes(item.model)) errors.push(`${item.label}: 模型 ${item.model} 不在 ${item.provider} 可用清單中`);
  }
  return errors;
}

/** 取出最後一個 ```multi-agent-json 區塊並解析。沒有區塊回傳 null。 */
export function extractDefinitionBlock(text: string): { value: unknown } | { error: string } | null {
  const matches = [...text.matchAll(/```multi-agent-json\s*\n([\s\S]*?)```/g)];
  const last = matches.at(-1);
  if (!last) return null;
  try {
    return { value: JSON.parse(last[1]) };
  } catch (error) {
    return { error: `JSON 解析失敗：${(error as Error).message}` };
  }
}

/** 解析 @ 提及。回傳成員 id 列表；@所有人 回傳全部成員；未 @ 依 unmentionedBehavior。 */
export function resolveMentions(
  content: string,
  members: Pick<ChatMember, 'id' | 'name'>[],
  unmentionedBehavior: ChatRules['unmentionedBehavior'],
): string[] {
  const mentioned = mentionedMemberIds(content, members);
  if (mentioned === 'all') return members.map((m) => m.id);
  if (mentioned.length) return mentioned;
  return unmentionedBehavior === 'all' ? members.map((m) => m.id) : [];
}

/** 文字中被 @ 的成員 id（依成員順序），含 @所有人 時回傳 'all'。 */
export function mentionedMemberIds(content: string, members: Pick<ChatMember, 'id' | 'name'>[]): string[] | 'all' {
  const tokens = new Set(
    [...content.matchAll(/@([^\s@，。,.!?！？:：;；]+)/gu)].map((m) => m[1].toLowerCase()),
  );
  if (EVERYONE_ALIASES.some((alias) => tokens.has(alias))) return 'all';
  return members.filter((m) => tokens.has(m.name.trim().toLowerCase())).map((m) => m.id);
}
