import type { SearchableMessage } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';
import { readJsonlEntries } from '@/shared/utils.js';

const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  'Invalid API key',
  '[Request interrupted',
] as const;

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part: AnyRecord) => part?.type === 'text' && typeof part?.text === 'string')
    .map((part: AnyRecord) => String(part.text))
    .join(' ');
}

function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

/** `<command-name>` 等本機指令包裝 → 使用者看到的指令文字；不是指令包裝時回傳 null。 */
function localCommandDisplayText(content: string): string | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  const baseCommand = (commandName ?? '').trim() || (commandMessage ?? '').trim();
  if (!baseCommand) {
    return '';
  }

  const args = (commandArgs ?? '').trim();
  return args ? `${baseCommand} ${args}` : baseCommand;
}

function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * Claude mixes visible chat, compact summaries, and local command wrappers into
 * the same transcript stream. Search should operate on the user-visible meaning
 * of those rows rather than the raw wrapper syntax.
 */
function extractClaudeSearchableMessage(entry: AnyRecord): { text: string; role: 'user' | 'assistant' } | null {
  if (!entry.message?.content || entry.isApiErrorMessage) {
    return null;
  }

  const rawRole = entry.message.role;
  if (rawRole !== 'user' && rawRole !== 'assistant') {
    return null;
  }

  if (typeof entry.message.content === 'string') {
    const content = String(entry.message.content);

    if (entry.isCompactSummary === true && content.trim()) {
      return { text: content, role: 'assistant' };
    }

    const commandText = localCommandDisplayText(content);
    if (commandText !== null) {
      return commandText ? { text: commandText, role: 'user' } : null;
    }

    const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
    if (localCommandStdout !== null) {
      const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
      return stdoutText ? { text: stdoutText, role: 'assistant' } : null;
    }

    if (!content || isInternalContent(content)) {
      return null;
    }

    return { text: content, role: rawRole };
  }

  const text = extractClaudeText(entry.message.content);
  if (!text) {
    return null;
  }

  if (entry.isCompactSummary === true) {
    return { text, role: 'assistant' };
  }

  if (isInternalContent(text)) {
    return null;
  }

  return { text, role: rawRole };
}

/**
 * 一個 Claude JSONL 可能含多個會話（resume），沒有 sessionId 的行沿用上一行的會話。
 *
 * 摘要來源依序：帶 sessionId 的 summary 行、leafUuid 指向的 summary（第一個被引用者）、
 * `/compact` 產生的 compact summary（它描述的正是續接後的狀態，優先於其他摘要）。
 */
export async function* extractClaudeSearchableMessages(filePath: string): AsyncGenerator<SearchableMessage> {
  let currentSessionId: string | null = null;
  const pendingSummariesBySession = new Map<string, Map<string, string>>();
  const resolvedSessions = new Set<string>();

  for await (const entry of readJsonlEntries(filePath)) {
    if (entry.sessionId) {
      currentSessionId = String(entry.sessionId);
    }
    const sessionId = currentSessionId;
    if (!sessionId) {
      continue;
    }

    if (entry.type === 'summary' && entry.summary) {
      const summary = String(entry.summary);
      if (entry.sessionId) {
        resolvedSessions.add(sessionId);
        yield { sessionId, role: 'summary', text: summary };
      } else if (entry.leafUuid) {
        if (!pendingSummariesBySession.has(sessionId)) {
          pendingSummariesBySession.set(sessionId, new Map());
        }
        pendingSummariesBySession.get(sessionId)!.set(String(entry.leafUuid), summary);
      }
    }

    if (!resolvedSessions.has(sessionId) && entry.parentUuid) {
      const pending = pendingSummariesBySession.get(sessionId)?.get(String(entry.parentUuid));
      if (pending) {
        resolvedSessions.add(sessionId);
        yield { sessionId, role: 'summary', text: pending };
      }
    }

    const message = extractClaudeSearchableMessage(entry);
    if (!message) {
      continue;
    }

    if (entry.isCompactSummary === true) {
      resolvedSessions.add(sessionId);
      yield { sessionId, role: 'summary', text: message.text };
    }

    yield {
      sessionId,
      role: message.role,
      text: message.text,
      timestamp: entry.timestamp ? String(entry.timestamp) : null,
      messageUuid: entry.uuid ? String(entry.uuid) : null,
    };
  }
}
