import { safeLocalStorage } from './chatStorage';

const STORAGE_KEY = 'session_mention_labels';
const MAX_SAVED_LABELS = 200;
const SESSION_LABEL_RE = /@session\["(?:\\.|[^"\\])*"\]/g;
const labels = new Map<string, string>();

function loadLabels() {
  try {
    const saved = JSON.parse(safeLocalStorage.getItem(STORAGE_KEY) || '{}');
    for (const [label, path] of Object.entries(saved)) {
      if (typeof path === 'string' && /^@session:[A-Za-z0-9_-]{1,128}$/.test(path)) {
        labels.set(label, path);
      }
    }
  } catch { /* 保留本次使用期間的對應。 */ }
}

/** 標題可重複；以序號區分，並保存對應以支援草稿還原。 */
export function createSessionMentionLabel(title: string, path: string): string {
  loadLabels();
  const name = title.replace(/\s+/g, ' ').trim() || '未命名會話';
  let label = `@session[${JSON.stringify(name)}]`;
  for (let index = 2; labels.has(label) && labels.get(label) !== path; index++) {
    label = `@session[${JSON.stringify(`${name} (${index})`)}]`;
  }
  for (const [existingLabel, existingPath] of labels) {
    if (existingPath === path && existingLabel !== label) {
      labels.delete(existingLabel);
    }
  }
  labels.delete(label);
  labels.set(label, path);
  while (labels.size > MAX_SAVED_LABELS) {
    const oldest = labels.keys().next().value;
    if (oldest === undefined) break;
    labels.delete(oldest);
  }
  safeLocalStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(labels)));
  return label;
}

export function extractKnownSessionMentionLabels(text: string): string[] {
  if (!text) return [];
  loadLabels();
  const matches = text.match(SESSION_LABEL_RE);
  return matches ? matches.filter((label) => labels.has(label)) : [];
}

export function resolveSessionMentionLabels(text: string): string {
  loadLabels();
  return text.replace(SESSION_LABEL_RE, (label) => labels.get(label) ?? label);
}
