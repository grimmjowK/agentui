/**
 * 生成中送出的待送佇列（chat-queued-steer-composer design D1）。
 *
 * 以會話為 key 保存在記憶體，切換會話時不清除；重新整理頁面後消失。
 * 新會話在拿到 id 之前使用 NEW_SESSION_KEY，拿到後以 renameSession 搬移。
 */
import { useSyncExternalStore } from 'react';

export const NEW_SESSION_KEY = '__new__';

export interface QueuedMessage {
  id: string;
  text: string;
  images: File[];
  /** 已送出 chat-steer、等待後端回覆中 */
  steering: boolean;
}

type QueueState = Record<string, QueuedMessage[]>;

const EMPTY: QueuedMessage[] = [];
let state: QueueState = {};
const listeners = new Set<() => void>();

function setQueue(key: string, next: QueuedMessage[]) {
  const copy = { ...state };
  if (next.length) copy[key] = next;
  else delete copy[key];
  state = copy;
  listeners.forEach((listener) => listener());
}

export const queuedMessages = {
  get(key: string): QueuedMessage[] {
    return state[key] ?? EMPTY;
  },

  enqueue(key: string, text: string, images: File[] = []): QueuedMessage {
    const item: QueuedMessage = { id: crypto.randomUUID(), text, images, steering: false };
    setQueue(key, [...queuedMessages.get(key), item]);
    return item;
  },

  remove(key: string, id: string) {
    const queue = queuedMessages.get(key);
    if (queue.some((item) => item.id === id)) setQueue(key, queue.filter((item) => item.id !== id));
  },

  /** 取出並移除第一則不在引導中的項目。 */
  takeNext(key: string): QueuedMessage | null {
    const queue = queuedMessages.get(key);
    const next = queue.find((item) => !item.steering);
    if (!next) return null;
    setQueue(key, queue.filter((item) => item !== next));
    return next;
  },

  setSteering(key: string, id: string, steering: boolean) {
    const queue = queuedMessages.get(key);
    if (!queue.some((item) => item.id === id && item.steering !== steering)) return;
    setQueue(key, queue.map((item) => (item.id === id ? { ...item, steering } : item)));
  },

  /** 會話 id 確定或被替換時，把佇列接到新 key 後面。 */
  renameSession(from: string, to: string) {
    if (from === to) return;
    const moving = queuedMessages.get(from);
    if (!moving.length) return;
    const copy = { ...state };
    delete copy[from];
    copy[to] = [...(copy[to] ?? EMPTY), ...moving];
    state = copy;
    listeners.forEach((listener) => listener());
  },

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** 測試用 */
  reset() {
    state = {};
    listeners.forEach((listener) => listener());
  },
};

export function useQueuedMessages(key: string): QueuedMessage[] {
  return useSyncExternalStore(queuedMessages.subscribe, () => queuedMessages.get(key));
}
