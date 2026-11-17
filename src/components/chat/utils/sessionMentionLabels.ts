import { safeLocalStorage } from './chatStorage';

const STORAGE_KEY = 'session_mention_labels';
const MAX_SAVED_LABELS = 200;
const LABEL_PREFIX = '@session[';
const SESSION_LABEL_RE = /@session\["(?:\\.|[^"\\])*"\]/g;
const SESSION_ID_RE = /@session:([A-Za-z0-9_-]{1,128})/g;
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

function saveLabels() {
  while (labels.size > MAX_SAVED_LABELS) {
    const oldest = labels.keys().next().value;
    if (oldest === undefined) break;
    labels.delete(oldest);
  }
  safeLocalStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(labels)));
}

/**
 * 標題可重複；以序號區分，並保存對應以支援草稿還原。
 * 標籤一經分配就固定指向該 ID（改名後舊標籤仍保留），避免草稿或佇列中的舊標籤被分給別的會話；
 * 舊標籤只由數量上限淘汰。
 */
export function createSessionMentionLabel(title: string, path: string): string {
  loadLabels();
  const name = title.replace(/\s+/g, ' ').trim() || '未命名會話';
  let label = `${LABEL_PREFIX}${JSON.stringify(name)}]`;
  for (let index = 2; labels.has(label) && labels.get(label) !== path; index++) {
    label = `${LABEL_PREFIX}${JSON.stringify(`${name} (${index})`)}]`;
  }
  labels.delete(label);
  labels.set(label, path);
  saveLabels();
  return label;
}

export function extractKnownSessionMentionLabels(text: string): string[] {
  if (!text?.includes(LABEL_PREFIX)) return [];
  loadLabels();
  const matches = text.match(SESSION_LABEL_RE);
  return matches ? matches.filter((label) => labels.has(label)) : [];
}

export function resolveSessionMentionLabels(text: string): string {
  if (!text?.includes(LABEL_PREFIX)) return text;
  loadLabels();
  return text.replace(SESSION_LABEL_RE, (label) => labels.get(label) ?? label);
}

/** 发送前一次性解析，并返回其中无法还原成 session ID 的标签。 */
export function resolveSessionMentionLabelsForSend(text: string): {
  resolvedText: string;
  unresolvedLabels: string[];
} {
  if (!text?.includes(LABEL_PREFIX)) {
    return { resolvedText: text, unresolvedLabels: [] };
  }
  loadLabels();
  const matchedLabels = text.match(SESSION_LABEL_RE) ?? [];
  return {
    resolvedText: text.replace(SESSION_LABEL_RE, (label) => labels.get(label) ?? label),
    unresolvedLabels: [...new Set(matchedLabels.filter((label) => !labels.has(label)))],
  };
}

/** 訊息氣泡顯示用：把 `@session:<id>` 換回本機記得的標題標籤，找不到則保留 ID。 */
export function formatSessionMentionsForDisplay(text: string): string {
  if (!text?.includes('@session:')) return text;
  loadLabels();
  const titles = new Map<string, string>();
  // 後加入的標籤較新（例如改名後），覆蓋舊標題
  for (const [label, path] of labels) titles.set(path, label);
  return text.replace(SESSION_ID_RE, (mention) => titles.get(mention) ?? mention);
}
