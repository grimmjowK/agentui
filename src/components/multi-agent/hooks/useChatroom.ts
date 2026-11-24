/**
 * 聊天室訊息：分頁載入歷史，訂閱 multi-agent-message / multi-agent-turn 事件。
 * 重連時重新取得訊息列表（執行中訊息帶已累積內容）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import { api } from '../../../utils/api';
import type { ChatMessage } from '../types/types';
import { readData } from '../utils/fetchJson';

const PAGE = 50;

type MessageEvent =
  | { type: 'multi-agent-message'; multiAgentId: string; kind: 'upsert'; message: ChatMessage }
  | { type: 'multi-agent-message'; multiAgentId: string; kind: 'delta'; messageId: string; content: string; turnId: string }
  | { type: 'multi-agent-turn'; multiAgentId: string; turnId: string; status: string };

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadingMore = useRef(false);
  const requestSeqRef = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    try {
      const data = await readData<{ messages: ChatMessage[]; activeTurnId: string | null }>(
        api.multiAgent.messages(multiAgentId, { limit: PAGE }),
      );
      if (seq !== requestSeqRef.current) return;
      setMessages(data.messages);
      setActiveTurnId(data.activeTurnId);
      setHasMore(data.messages.length === PAGE);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError((err as Error).message);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [multiAgentId]);

  useEffect(() => {
    requestSeqRef.current += 1;
    loadingMore.current = false;
    setMessages([]);
    setActiveTurnId(null);
    setHasMore(false);
    setLoading(true);
    setError(null);
  }, [multiAgentId]);

  useEffect(() => { void reload(); }, [reload, isConnected]);

  const loadEarlier = useCallback(async () => {
    const first = messages[0];
    if (!first || loadingMore.current) return;
    loadingMore.current = true;
    try {
      const data = await readData<{ messages: ChatMessage[] }>(
        api.multiAgent.messages(multiAgentId, { beforeSeq: first.seq, limit: PAGE }),
      );
      setMessages((current) => [...data.messages.filter((m) => !current.some((c) => c.id === m.id)), ...current]);
      setHasMore(data.messages.length === PAGE);
    } finally {
      loadingMore.current = false;
    }
  }, [messages, multiAgentId]);

  useEffect(() => {
    const event = latestMessage as MessageEvent | null;
    if (!event || event.multiAgentId !== multiAgentId) return;
    if (event.type === 'multi-agent-turn') {
      setActiveTurnId(['running', 'stopping'].includes(event.status) ? event.turnId : null);
      return;
    }
    if (event.type !== 'multi-agent-message') return;
    if (event.kind === 'upsert') {
      setMessages((current) => upsert(current, event.message));
      if (event.message.turnId && event.message.status === 'streaming') setActiveTurnId(event.message.turnId);
    } else {
      setMessages((current) => current.map((m) => (m.id === event.messageId ? { ...m, content: event.content } : m)));
    }
  }, [latestMessage, multiAgentId]);

  const send = useCallback(async (content: string) => {
    setError(null);
    try {
      const message = await readData<ChatMessage>(api.multiAgent.sendMessage(multiAgentId, content));
      setMessages((current) => upsert(current, message));
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

  const stop = useCallback(async () => {
    if (!activeTurnId) return;
    try {
      await readData(api.multiAgent.stopTurn(multiAgentId, activeTurnId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeTurnId, multiAgentId]);

  return { messages, activeTurnId, hasMore, loading, error, clearError: () => setError(null), send, cancelQueued, stop, loadEarlier };
}
