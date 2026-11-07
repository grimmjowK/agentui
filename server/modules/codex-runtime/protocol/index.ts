// codex-cli 0.163.0 · 由 npm run codex:gen-types 生成，請勿手動修改。

import type { AgentMessageDeltaNotification } from './v2/AgentMessageDeltaNotification.js';
import type { CommandExecutionRequestApprovalParams } from './v2/CommandExecutionRequestApprovalParams.js';
import type { CommandExecutionRequestApprovalResponse } from './v2/CommandExecutionRequestApprovalResponse.js';
import type { ErrorNotification } from './v2/ErrorNotification.js';
import type { FileChangeRequestApprovalParams } from './v2/FileChangeRequestApprovalParams.js';
import type { FileChangeRequestApprovalResponse } from './v2/FileChangeRequestApprovalResponse.js';
import type { InitializeParams } from './InitializeParams.js';
import type { InitializeResponse } from './InitializeResponse.js';
import type { ItemCompletedNotification } from './v2/ItemCompletedNotification.js';
import type { ItemStartedNotification } from './v2/ItemStartedNotification.js';
import type { McpServerElicitationRequestParams } from './v2/McpServerElicitationRequestParams.js';
import type { McpServerElicitationRequestResponse } from './v2/McpServerElicitationRequestResponse.js';
import type { ModelListParams } from './v2/ModelListParams.js';
import type { ModelListResponse } from './v2/ModelListResponse.js';
import type { PermissionsRequestApprovalParams } from './v2/PermissionsRequestApprovalParams.js';
import type { PermissionsRequestApprovalResponse } from './v2/PermissionsRequestApprovalResponse.js';
import type { RequestId } from './RequestId.js';
import type { ThreadItem } from './v2/ThreadItem.js';
import type { ThreadReadParams } from './v2/ThreadReadParams.js';
import type { ThreadReadResponse } from './v2/ThreadReadResponse.js';
import type { ThreadResumeParams } from './v2/ThreadResumeParams.js';
import type { ThreadResumeResponse } from './v2/ThreadResumeResponse.js';
import type { ThreadStartParams } from './v2/ThreadStartParams.js';
import type { ThreadStartResponse } from './v2/ThreadStartResponse.js';
import type { ThreadTokenUsageUpdatedNotification } from './v2/ThreadTokenUsageUpdatedNotification.js';
import type { TurnCompletedNotification } from './v2/TurnCompletedNotification.js';
import type { TurnInterruptParams } from './v2/TurnInterruptParams.js';
import type { TurnInterruptResponse } from './v2/TurnInterruptResponse.js';
import type { TurnPlanUpdatedNotification } from './v2/TurnPlanUpdatedNotification.js';
import type { TurnStartParams } from './v2/TurnStartParams.js';
import type { TurnStartResponse } from './v2/TurnStartResponse.js';
import type { TurnStartedNotification } from './v2/TurnStartedNotification.js';
import type { TurnSteerParams } from './v2/TurnSteerParams.js';
import type { TurnSteerResponse } from './v2/TurnSteerResponse.js';

export type { AgentMessageDeltaNotification, CommandExecutionRequestApprovalParams, CommandExecutionRequestApprovalResponse, ErrorNotification, FileChangeRequestApprovalParams, FileChangeRequestApprovalResponse, InitializeParams, InitializeResponse, ItemCompletedNotification, ItemStartedNotification, McpServerElicitationRequestParams, McpServerElicitationRequestResponse, ModelListParams, ModelListResponse, PermissionsRequestApprovalParams, PermissionsRequestApprovalResponse, RequestId, ThreadItem, ThreadReadParams, ThreadReadResponse, ThreadResumeParams, ThreadResumeResponse, ThreadStartParams, ThreadStartResponse, ThreadTokenUsageUpdatedNotification, TurnCompletedNotification, TurnInterruptParams, TurnInterruptResponse, TurnPlanUpdatedNotification, TurnStartParams, TurnStartResponse, TurnStartedNotification, TurnSteerParams, TurnSteerResponse };

/** 介接層送出的請求：method → 參數與回應。 */
export type ClientRequestMap = {
  'initialize': { params: InitializeParams; result: InitializeResponse };
  'model/list': { params: ModelListParams; result: ModelListResponse };
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse };
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse };
  'thread/read': { params: ThreadReadParams; result: ThreadReadResponse };
  'turn/start': { params: TurnStartParams; result: TurnStartResponse };
  'turn/steer': { params: TurnSteerParams; result: TurnSteerResponse };
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse };
};

export type ClientRequestMethod = keyof ClientRequestMap;

/** 介接層處理的伺服器通知。 */
export type ServerNotification =
  | { method: 'error'; params: ErrorNotification }
  | { method: 'turn/started'; params: TurnStartedNotification }
  | { method: 'turn/completed'; params: TurnCompletedNotification }
  | { method: 'turn/plan/updated'; params: TurnPlanUpdatedNotification }
  | { method: 'item/started'; params: ItemStartedNotification }
  | { method: 'item/completed'; params: ItemCompletedNotification }
  | { method: 'item/agentMessage/delta'; params: AgentMessageDeltaNotification }
  | { method: 'thread/tokenUsage/updated'; params: ThreadTokenUsageUpdatedNotification }
  ;

/** 介接層回應的伺服器請求：method → 參數與回應。 */
export type ServerRequestMap = {
  'mcpServer/elicitation/request': { params: McpServerElicitationRequestParams; result: McpServerElicitationRequestResponse };
  'item/commandExecution/requestApproval': { params: CommandExecutionRequestApprovalParams; result: CommandExecutionRequestApprovalResponse };
  'item/fileChange/requestApproval': { params: FileChangeRequestApprovalParams; result: FileChangeRequestApprovalResponse };
  'item/permissions/requestApproval': { params: PermissionsRequestApprovalParams; result: PermissionsRequestApprovalResponse };
};

export type ServerRequest = {
  [M in keyof ServerRequestMap]: { method: M; id: RequestId; params: ServerRequestMap[M]['params'] };
}[keyof ServerRequestMap];
