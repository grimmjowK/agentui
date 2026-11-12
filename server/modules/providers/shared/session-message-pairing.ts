import type { NormalizedMessage } from '@/shared/types.js';

const INTERNAL_USER_PREFIXES = [
  '<recommended_plugins>',
  '<environment_context>',
  '<environments_instructions>',
  '<permissions instructions>',
  '<collaboration_mode>',
  '<skills_instructions>',
  '<user_instructions>',
  '<current_time_reminder>',
  '<context_window>',
  '<context_window_guidance>',
  '<persistent_mode>',
  '<subagent_notification>',
  '<system-reminder>',
  '# AGENTS.md instructions for ',
  // Skill 工具加载的 skill 正文：历史里带 isMeta 已被过滤，但实时流里只有
  // isSynthetic（= isMeta || isVisibleInTranscriptOnly || isCompactSummary），不能整体
  // 过滤，按前缀精确拦掉。
  'Base directory for this skill:',
  'Caveat:',
] as const;

export function isInterruptedUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('<turn_aborted>')
    || trimmed.startsWith('Conversation interrupted')
    || trimmed.startsWith('[Request interrupted');
}

export function isInternalUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return INTERNAL_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function isNonPairingUserMessage(message: NormalizedMessage): boolean {
  if (message.kind !== 'text' || message.role !== 'user') return false;
  if (message.isInterrupted) return true;
  const text = message.content || '';
  return isInternalUserText(text)
    || isInterruptedUserText(text)
    || message.isLocalCommand === true
    || message.isLocalCommandStdout === true
    || message.isCompactSummary === true;
}
