export type {
  ChatMember,
  ChatMessage,
  ChatroomDef,
  ChatRules,
  MultiAgent,
  MultiAgentDefinition,
  MultiAgentKind,
  NodeRunState,
  NodeRunStatus,
  WorkflowDef,
  WorkflowNode,
  WorkflowRun,
} from '../../../../shared/multiAgent';

import type { MultiAgent } from '../../../../shared/multiAgent';

/** GET /:id 額外帶回工作目錄對應的專案 id，建立器的聊天頁需要它 */
export type MultiAgentDetail = MultiAgent & { projectId: string | null };

export type ApiEnvelope<T> = { success: boolean; data: T; error?: { message?: string } | string };
