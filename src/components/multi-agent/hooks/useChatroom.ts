/**
 * 聊天室訊息與多對話（thread）管理：
 * 支援在同一聊天室設定下開啟多個獨立對話、同時並行發言，並訂閱 multi-agent-message / multi-agent-turn 事件。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import { api } from '../../../utils/api';
import type { ChatMessage, ChatThread } from '../types/types';
import { readData } from '../utils/fetchJson';

const PAGE = 50;

type MessageEvent =
  | { type: 'multi-agent-message'; multiAgentId: string; threadId?: string; kind: 'upsert'; message: ChatMessage }
  | { type: 'multi-agent-message'; multiAgentId: string; threadId?: string; kind: 'delta'; messageId: string; content: string; turnId: string }
  | { type: 'multi-agent-turn'; multiAgentId: string; threadId?: string; turnId: string; status: string };

function upsert(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const existing = list.find((m) => m.id === message.id);
  // 送出的 HTTP 回應（queued）可能晚於 WS 推送的「已開始處理」，不能把狀態倒回去
  if (existing && message.status === 'queued' && existing.status !== 'queued') return list;
  const without = list.filter((m) => m.id !== message.id);
  // 排隊訊息開始處理時 seq 會重新取號，依 seq 重排
  return [...without, message].sort((a, b) => a.seq - b.seq);
}

export function useChatroom(multiAgentId: string) {
  const { latestMessage, isConnected } = useWebSocket();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string>('default');
  const [activeTurns, setActiveTurns] = useState<Record<string, string | null>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadingMore = useRef(false);
  const requestSeqRef = useRef(0);
  const selectedThreadRef = useRef(selectedThreadId);
  selectedThreadRef.current = selectedThreadId;

  const reloadMessages = useCallback(async (threadId: string) => {
    loadingMore.current = false;
    const seq = ++requestSeqRef.current;
    try {
      const data = await readData<{ messages: ChatMessage[]; activeTurnId: string | null }>(
        api.multiAgent.messages(multiAgentId, { threadId, limit: PAGE }),
      );
      if (seq !== requestSeqRef.current) return;
      setMessages(data.messages);
      setActiveTurns((prev) => ({ ...prev, [threadId]: data.activeTurnId }));
      setHasMore(data.messages.length === PAGE);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError((err as Error).message);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [multiAgentId]);

  const reloadThreads = useCallback(async (preferThreadId?: string, ensureActive = false) => {
    const seq = ++requestSeqRef.current;
    try {
      let data = await readData<{ threads: ChatThread[]; activeTurns: Record<string, string> }>(
        api.multiAgent.listThreads(multiAgentId),
      );
      if (seq !== requestSeqRef.current) return;
      let unarchived = data.threads.filter((t) => !t.isArchived);
      if (ensureActive && unarchived.length === 0) {
        const created = await readData<ChatThread>(api.multiAgent.createThread(multiAgentId));
        if (seq !== requestSeqRef.current) return;
        data = { ...data, threads: [created, ...data.threads.filter((t) => t.id !== created.id)] };
        unarchived = [created];
      }
      setThreads(data.threads);
      setActiveTurns(data.activeTurns ?? {});
      const targetId = preferThreadId && data.threads.some((t) => t.id === preferThreadId && !t.isArchived)
        ? preferThreadId
        : unarchived[0]?.id ?? data.threads[0]?.id ?? 'default';
      selectedThreadRef.current = targetId;
      setSelectedThreadId(targetId);
      await reloadMessages(targetId);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError((err as Error).message);
      setLoading(false);
    }
  }, [multiAgentId, reloadMessages]);

  useEffect(() => {
    requestSeqRef.current += 1;
    loadingMore.current = false;
    setThreads([]);
    selectedThreadRef.current = 'default';
    setSelectedThreadId('default');
    setActiveTurns({});
    setMessages([]);
    setHasMore(false);
    setLoading(true);
    setError(null);
  }, [multiAgentId]);

  useEffect(() => {
    void reloadThreads(selectedThreadRef.current);
    return () => { requestSeqRef.current += 1; };
  }, [reloadThreads, isConnected]);

  const selectThread = useCallback((threadId: string) => {
    if (threadId === selectedThreadRef.current) return;
    selectedThreadRef.current = threadId;
    loadingMore.current = false;
    setSelectedThreadId(threadId);
    setMessages([]);
    setHasMore(false);
    setLoading(true);
    void reloadMessages(threadId);
  }, [reloadMessages]);

  const createThread = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    loadingMore.current = false;
    setError(null);
    try {
      const created = await readData<ChatThread>(api.multiAgent.createThread(multiAgentId));
      if (seq !== requestSeqRef.current) return;
      selectedThreadRef.current = created.id;
      setThreads((prev) => [created, ...prev.filter((t) => t.id !== created.id)]);
      setSelectedThreadId(created.id);
      setMessages([]);
      setHasMore(false);
      setLoading(false);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError((err as Error).message);
      await reloadMessages(selectedThreadRef.current);
    }
  }, [multiAgentId, reloadMessages]);

  const deleteThread = useCallback(async (threadId: string, options: { force?: boolean } = {}) => {
    setError(null);
    try {
      await readData<{ id: string; archived?: boolean; deleted?: boolean }>(
        api.multiAgent.deleteThread(multiAgentId, threadId, options),
      );
      // 無論歸檔或永久刪除，若刪除後已無任何未歸檔對話，由 reloadThreads 自動補建一個新對話避免誤跳入已歸檔對話
      await reloadThreads(selectedThreadRef.current === threadId ? undefined : selectedThreadRef.current, true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId, reloadThreads]);

  const restoreThread = useCallback(async (threadId: string) => {
    setError(null);
    try {
      await readData(api.multiAgent.restoreThread(multiAgentId, threadId));
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, isArchived: false } : t)));
      selectThread(threadId);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId, selectThread]);

  const loadEarlier = useCallback(async () => {
    const first = messages[0];
    if (!first || loadingMore.current) return;
    loadingMore.current = true;
    const seq = requestSeqRef.current;
    try {
      const data = await readData<{ messages: ChatMessage[] }>(
        api.multiAgent.messages(multiAgentId, { threadId: selectedThreadId, beforeSeq: first.seq, limit: PAGE }),
      );
      if (seq !== requestSeqRef.current) return;
      setMessages((current) => [...data.messages.filter((m) => !current.some((c) => c.id === m.id)), ...current]);
      setHasMore(data.messages.length === PAGE);
    } finally {
      if (seq === requestSeqRef.current) loadingMore.current = false;
    }
  }, [messages, multiAgentId, selectedThreadId]);

  useEffect(() => {
    const event = latestMessage as MessageEvent | null;
    if (!event || event.multiAgentId !== multiAgentId) return;
    const evThreadId = event.threadId ?? (event.type === 'multi-agent-message' && event.kind === 'upsert' ? event.message.threadId : undefined) ?? 'default';

    if (event.type === 'multi-agent-turn') {
      const nextTurnId = ['running', 'stopping'].includes(event.status) ? event.turnId : null;
      setActiveTurns((prev) => ({ ...prev, [evThreadId]: nextTurnId }));
      return;
    }
    if (event.type !== 'multi-agent-message') return;
    if (event.kind === 'upsert') {
      if (event.message.turnId && event.message.status === 'streaming') {
        setActiveTurns((prev) => ({ ...prev, [evThreadId]: event.message.turnId }));
      }
      if (event.message.authorKind === 'user') {
        const snippet = event.message.content.trim().replace(/\s+/g, ' ').slice(0, 32);
        if (snippet) {
          setThreads((prev) => prev.map((t) => (
            t.id === evThreadId && ['新對話', '新对话', 'New chat'].includes(t.title)
              ? { ...t, title: snippet, updatedAt: event.message.createdAt }
              : t.id === evThreadId
                ? { ...t, updatedAt: event.message.createdAt }
                : t
          )));
        }
      }
      if (evThreadId === selectedThreadRef.current) {
        setMessages((current) => upsert(current, event.message));
      }
    } else if (evThreadId === selectedThreadRef.current) {
      setMessages((current) => current.map((m) => (m.id === event.messageId ? { ...m, content: event.content } : m)));
    }
  }, [latestMessage, multiAgentId]);

  const send = useCallback(async (content: string) => {
    setError(null);
    const threadId = selectedThreadRef.current;
    try {
      const message = await readData<ChatMessage>(api.multiAgent.sendMessage(multiAgentId, content, threadId));
      const snippet = content.trim().replace(/\s+/g, ' ').slice(0, 32);
      if (snippet) {
        setThreads((prev) => prev.map((t) => (
          t.id === threadId && ['新對話', '新对话', 'New chat'].includes(t.title)
            ? { ...t, title: snippet, updatedAt: message.createdAt }
            : t
        )));
      }
      if (threadId === selectedThreadRef.current) {
        setMessages((current) => upsert(current, message));
      }
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  }, [multiAgentId]);

  const cancelQueued = useCallback(async (messageId: string) => {
    try {
      await readData(api.multiAgent.cancelQueued(multiAgentId, messageId));
      setMessages((current) => current.filter((m) => m.id !== messageId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId]);

  const activeTurnId = activeTurns[selectedThreadId] ?? null;

  const stop = useCallback(async () => {
    if (!activeTurnId) return;
    try {
      await readData(api.multiAgent.stopTurn(multiAgentId, activeTurnId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeTurnId, multiAgentId]);

  return {
    threads,
    selectedThreadId,
    selectThread,
    createThread,
    deleteThread,
    restoreThread,
    activeTurns,
    messages,
    activeTurnId,
    hasMore,
    loading,
    error,
    clearError: () => setError(null),
    send,
    cancelQueued,
    stop,
    loadEarlier,
  };
}
