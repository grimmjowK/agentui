import type { MentionableFile } from '../hooks/useFileMentions';

/**
 * `@session...` 开头时进入会话模式：只列会话（最多 20 笔），`session:` 之后的字比对标题与 id；
 * 否则文件在前（最多 10 笔）、会话在后（最多 5 笔）。
 */
export function filterMentionCandidates(
  query: string,
  files: MentionableFile[],
  sessions: MentionableFile[],
): MentionableFile[] {
  const lowered = query.toLowerCase();
  if (lowered.startsWith('session')) {
    const term = lowered.replace(/^session:?/, '');
    return sessions
      .filter((item) => item.name.toLowerCase().includes(term) || item.path.toLowerCase().includes(term))
      .slice(0, 20);
  }
  const matches = (item: MentionableFile) =>
    item.name.toLowerCase().includes(lowered) || item.path.toLowerCase().includes(lowered);
  return [...files.filter(matches).slice(0, 10), ...sessions.filter(matches).slice(0, 5)];
}
