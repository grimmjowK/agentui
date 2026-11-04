import type { SearchableMessage } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';
import { readJsonlEntries } from '@/shared/utils.js';

/**
 * Codex includes extra internal metadata tags that should not surface as
 * user-facing searchable conversation content.
 */
const CODEX_INTERNAL_CONTENT_PREFIXES = [
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
  '<turn_aborted>',
  '# AGENTS.md instructions for ',
  '<cwd>',
] as const;

function isInternalCodexContent(content: string): boolean {
  const normalized = content.trimStart();
  return CODEX_INTERNAL_CONTENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function extractCodexText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item: AnyRecord) => (
      (item?.type === 'input_text' || item?.type === 'output_text' || item?.type === 'text')
      && typeof item.text === 'string'
        ? item.text
        : ''
    ))
    .filter(Boolean)
    .join(' ');
}

function isVisibleCodexUserMessage(payload: AnyRecord | null | undefined): boolean {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}

function readRolloutMessage(entry: AnyRecord): { text: string; role: 'user' | 'assistant' } | null {
  const payload = entry.payload as AnyRecord | undefined;

  if (entry.type === 'event_msg') {
    if (isVisibleCodexUserMessage(payload)) {
      return { text: String(payload!.message), role: 'user' };
    }
    if (payload?.type === 'agent_reasoning' && typeof payload.text === 'string') {
      return { text: payload.text, role: 'assistant' };
    }
    return null;
  }

  if (entry.type !== 'response_item') {
    return null;
  }

  if (payload?.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
    return { text: extractCodexText(payload.content), role: payload.role };
  }

  if (payload?.type === 'reasoning' && Array.isArray(payload.summary)) {
    const summaryText = payload.summary
      .map((item: AnyRecord) => (typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
    return summaryText.trim() ? { text: summaryText, role: 'assistant' } : null;
  }

  return null;
}

/**
 * Codex 的同一則訊息會同時以 event_msg 與 response_item 記錄，以「角色 + 文字」去重。
 * 會話摘要取最後一則使用者訊息（含重複的那幾則），所以每則使用者訊息都另送一個 summary。
 */
export async function* extractCodexSearchableMessages(filePath: string): AsyncGenerator<SearchableMessage> {
  const seenFingerprints = new Set<string>();

  for await (const entry of readJsonlEntries(filePath)) {
    const message = readRolloutMessage(entry);
    if (!message?.text || isInternalCodexContent(message.text)) {
      continue;
    }

    if (message.role === 'user') {
      yield { role: 'summary', text: message.text };
    }

    const fingerprint = `${message.role}:${message.text.trim().toLowerCase()}`;
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }
    seenFingerprints.add(fingerprint);

    yield {
      role: message.role,
      text: message.text,
      timestamp: entry.timestamp ? String(entry.timestamp) : null,
    };
  }
}
