/**
 * 執行中的工作流節點會話登記（node-live-session-and-agy-acp design D2）。
 * 放在 shared，讓 WebSocket 層與工作流執行器都能引用而不互相依賴。
 */
export type WorkflowResumeMeta = {
  images?: unknown;
  permissionMode?: string;
  model?: string;
};

export type LiveWorkflowSession = {
  multiAgentId: string;
  runId: string;
  nodeId: string;
  nodeTitle: string;
  userId: string | number;
  /** running：輸出中（含等待審批）；waiting_input：使用者中斷後等待新指示 */
  state(): 'running' | 'waiting_input';
  /** 使用者在聊天頁中斷：這一輪結束後節點進入 waiting_input 而不是失敗 */
  markUserInterrupted(): void;
  /** waiting_input 時送出新指示，以同一 sessionId 續接；非等待狀態回傳 false */
  resume(text: string, clientId: string, imagesOrMeta?: unknown): boolean;
};

export type WorkflowContinueResult = 'not_workflow' | 'continued' | 'busy' | 'empty';

type ContinueHandler = (
  sessionId: string,
  userId: string | number | null,
  text: string,
  clientId: string,
  imagesOrMeta?: unknown,
) => Promise<WorkflowContinueResult> | WorkflowContinueResult;

const live = new Map<string, LiveWorkflowSession>();
let continueHandler: ContinueHandler | null = null;

export const workflowSessions = {
  register(sessionId: string, entry: LiveWorkflowSession): void {
    live.set(sessionId, entry);
  },
  unregister(sessionId: string, entry: LiveWorkflowSession): void {
    if (live.get(sessionId) === entry) live.delete(sessionId);
  },
  get(sessionId: string | null | undefined): LiveWorkflowSession | null {
    return (sessionId && live.get(sessionId)) || null;
  },
  /** 由 WorkflowRunner 註冊：當使用者在已完成／失敗的節點對話頁發送新訊息時，自動續接該節點並往後流轉下游 */
  onContinue(handler: ContinueHandler): void {
    continueHandler = handler;
  },
  async continueSession(
    sessionId: string | null | undefined,
    userId: string | number | null,
    text: string,
    clientId: string,
    images?: unknown,
  ): Promise<WorkflowContinueResult> {
    if (!sessionId || !continueHandler) return 'not_workflow';
    return continueHandler(sessionId, userId, text, clientId, images);
  },
};
