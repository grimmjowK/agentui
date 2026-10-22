import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlertIcon } from 'lucide-react';

import type { PendingPermissionRequest } from '../../types/types';
import { buildClaudeToolPermissionEntry, formatToolInputForDisplay } from '../../utils/chatPermissions';
import { getClaudeSettings } from '../../utils/chatStorage';
import { getPermissionPanel, registerPermissionPanel } from '../../tools/configs/permissionPanelRegistry';
import { AskUserQuestionPanel } from '../../tools/components/InteractiveRenderers';
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationActions,
  ConfirmationAction,
} from '../../../../shared/view/ui';

registerPermissionPanel('AskUserQuestion', AskUserQuestionPanel);

type CodexApprovalSummary = {
  label: string;
  body: boolean;
  command?: string;
  cwd?: string;
  files?: string;
  reason?: string;
};

/**
 * 从 Codex 审批请求的 input 里提取可读摘要，供卡片主体展示。
 * input 是后端 { ...params, item } 的展开：命令审批带 command/cwd/reason；
 * 文件审批的变更在 item 上（changes 列表），params 带 reason/grantRoot。
 */
function buildCodexApprovalSummary(toolName: string, input: Record<string, unknown>): CodexApprovalSummary {
  const reason = typeof input.reason === 'string' ? input.reason : undefined;
  if (toolName === 'item/commandExecution/requestApproval') {
    const command = typeof input.command === 'string' ? input.command : undefined;
    const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
    return { label: 'commandExecution', body: Boolean(command || cwd || reason), command, cwd, reason };
  }
  if (toolName === 'item/fileChange/requestApproval') {
    const item = input.item as { changes?: Array<{ path?: string }> } | undefined;
    const paths = Array.isArray(item?.changes)
      ? item!.changes.map((change) => change?.path).filter((p): p is string => Boolean(p))
      : [];
    const grantRoot = typeof input.grantRoot === 'string' ? input.grantRoot : undefined;
    const files = paths.length ? paths.join(', ') : grantRoot;
    return { label: 'fileChange', body: Boolean(files || reason), files, reason };
  }
  // 未知类型：无结构化摘要，仅靠标题 + 可折叠详情展示。
  return { label: toolName, body: false };
}

interface PermissionRequestsBannerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
}

export default function PermissionRequestsBanner({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
}: PermissionRequestsBannerProps) {
  const { t } = useTranslation('chat');
  const [now, setNow] = useState(Date.now());
  const [submitted, setSubmitted] = useState<Set<string>>(new Set());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // Filter out plan tool requests — they are handled inline by PlanDisplay
  const filteredRequests = pendingPermissionRequests.filter(
    (r) => r.toolName !== 'ExitPlanMode' && r.toolName !== 'exit_plan_mode'
  );

  if (!filteredRequests.length) {
    return null;
  }

  return (
    <div className="mb-3 space-y-2">
      {filteredRequests.map((request) => {
        if (request.provider === 'codex') {
          const context = request.context as { decisions?: string[]; expiresAt?: number } | undefined;
          const expired = Boolean(context?.expiresAt && context.expiresAt <= now);
          const input = (request.input ?? {}) as Record<string, unknown>;
          const summary = buildCodexApprovalSummary(request.toolName, input);
          return (
            <Confirmation key={request.requestId} approval="pending">
              <ConfirmationTitle className="flex items-start gap-3">
                <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <ConfirmationRequest>
                  <div>
                    <span className="font-medium text-foreground">{t('codex.approvals.title', 'Codex · Permission required')}</span>
                    {summary.label && (
                      <span className="ml-2 text-muted-foreground">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{summary.label}</code>
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {expired
                      ? t('codex.approvals.expired', 'Expired')
                      : t('codex.approvals.expires', { defaultValue: 'Expires at {{time}}', time: context?.expiresAt ? new Date(context.expiresAt).toLocaleTimeString() : '—' })}
                  </div>
                </ConfirmationRequest>
              </ConfirmationTitle>

              {summary.body && (
                <div className="mt-1 space-y-1 text-xs">
                  {summary.command && (
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-2 font-mono text-foreground">{summary.command}</pre>
                  )}
                  {summary.cwd && (
                    <div className="text-muted-foreground">
                      {t('codex.approvals.cwd', 'Working directory')}: <code className="rounded bg-muted px-1 py-0.5">{summary.cwd}</code>
                    </div>
                  )}
                  {summary.files && (
                    <div className="text-muted-foreground">
                      {t('codex.approvals.files', 'Files')}: <code className="rounded bg-muted px-1 py-0.5">{summary.files}</code>
                    </div>
                  )}
                  {summary.reason && (
                    <div className="text-muted-foreground">{summary.reason}</div>
                  )}
                </div>
              )}

              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  {t('codex.approvals.viewDetails', 'View request details')}
                </summary>
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
                  {JSON.stringify(request.input, null, 2)}
                </pre>
              </details>

              <ConfirmationActions>
                {(context?.decisions || ['decline']).map((decision) => (
                  <ConfirmationAction key={decision} variant="outline"
                    disabled={expired || submitted.has(request.requestId)}
                    onClick={() => {
                      setSubmitted((previous) => new Set(previous).add(request.requestId));
                      handlePermissionDecision(request.requestId, { updatedInput: decision });
                    }}>
                    {t(`codex.approvals.${decision}`, decision)}
                  </ConfirmationAction>
                ))}
              </ConfirmationActions>
            </Confirmation>
          );
        }
        const CustomPanel = getPermissionPanel(request.toolName);
        if (CustomPanel) {
          return (
            <CustomPanel
              key={request.requestId}
              request={request}
              onDecision={handlePermissionDecision}
            />
          );
        }

        const rawInput = formatToolInputForDisplay(request.input);
        const permissionEntry = buildClaudeToolPermissionEntry(request.toolName, rawInput);
        const settings = getClaudeSettings();
        const alreadyAllowed = permissionEntry ? settings.allowedTools.includes(permissionEntry) : false;
        const rememberLabel = alreadyAllowed ? 'Allow (saved)' : 'Allow & remember';
        const matchingRequestIds = permissionEntry
          ? pendingPermissionRequests
              .filter(
                (item) =>
                  buildClaudeToolPermissionEntry(item.toolName, formatToolInputForDisplay(item.input)) === permissionEntry,
              )
              .map((item) => item.requestId)
          : [request.requestId];

        return (
          <Confirmation key={request.requestId} approval="pending">
            <ConfirmationTitle className="flex items-start gap-3">
              <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <ConfirmationRequest>
                <div>
                  <span className="font-medium text-foreground">Permission required</span>
                  <span className="ml-2 text-muted-foreground">
                    Tool: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{request.toolName}</code>
                  </span>
                </div>
                {permissionEntry && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Allow rule: <code className="rounded bg-muted px-1 py-0.5 text-xs">{permissionEntry}</code>
                  </div>
                )}
              </ConfirmationRequest>
            </ConfirmationTitle>

            {rawInput && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  View tool input
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
                  {rawInput}
                </pre>
              </details>
            )}

            <ConfirmationActions>
              <ConfirmationAction
                variant="outline"
                onClick={() => handlePermissionDecision(request.requestId, { allow: false, message: 'User denied tool use' })}
              >
                Deny
              </ConfirmationAction>
              <ConfirmationAction
                variant="outline"
                onClick={() => {
                  if (permissionEntry && !alreadyAllowed) {
                    handleGrantToolPermission({ entry: permissionEntry, toolName: request.toolName });
                  }
                  handlePermissionDecision(matchingRequestIds, { allow: true, rememberEntry: permissionEntry });
                }}
                disabled={!permissionEntry}
              >
                {rememberLabel}
              </ConfirmationAction>
              <ConfirmationAction
                variant="default"
                onClick={() => handlePermissionDecision(request.requestId, { allow: true })}
              >
                Allow once
              </ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        );
      })}
    </div>
  );
}
