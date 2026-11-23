/**
 * 工作流執行狀態：支援同一工作流多個並行／歷史 run，依 multi-agent-run 事件按 runId 即時更新。
 */
import { useCallback, useEffect, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import { api } from '../../../utils/api';
import type { NodeRunStatus, WorkflowRun } from '../types/types';
import { readData } from '../utils/fetchJson';

type RunEvent = {
  type: 'multi-agent-run';
  multiAgentId: string;
  runId: string;
  status: WorkflowRun['status'];
  nodeStates?: Record<string, NodeRunStatus>;
  nodeId?: string;
  node?: NodeRunStatus;
};

export function useWorkflowRun(multiAgentId: string) {
  const { latestMessage, isConnected } = useWebSocket();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => {
    try {
      return new URLSearchParams(window.location.search).get('runId');
    } catch {
      return null;
    }
  });
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await readData<WorkflowRun[]>(api.multiAgent.listRuns(multiAgentId));
      setRuns(list);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId]);

  // 切換工作流時重置選中 runId（除非 URL 帶了 runId）
  useEffect(() => {
    try {
      setSelectedRunId(new URLSearchParams(window.location.search).get('runId'));
    } catch {
      setSelectedRunId(null);
    }
  }, [multiAgentId]);

  // 進入頁面與重新連線時從伺服器還原
  useEffect(() => { void reload(); }, [reload, isConnected]);

  useEffect(() => {
    const event = latestMessage as RunEvent | null;
    if (event?.type !== 'multi-agent-run' || event.multiAgentId !== multiAgentId) return;
    setRuns((current) => {
      const idx = current.findIndex((r) => r.id === event.runId);
      if (idx === -1) {
        // 新的 run（例如其他分頁開始的）：重新拉完整清單
        void reload();
        return current;
      }
      const target = current[idx];
      const nodeStates = event.nodeStates
        ? event.nodeStates
        : event.nodeId && event.node
          ? { ...target.nodeStates, [event.nodeId]: event.node }
          : target.nodeStates;
      const next = [...current];
      next[idx] = { ...target, status: event.status, nodeStates };
      return next;
    });
  }, [latestMessage, multiAgentId, reload]);

  const run = (selectedRunId ? runs.find((r) => r.id === selectedRunId) : null) ?? runs[0] ?? null;
  const activeRuns = runs.filter((r) => r.status === 'running' || r.status === 'stopping');

  const start = useCallback(async (input = '') => {
    setError(null);
    try {
      const created = await readData<WorkflowRun>(api.multiAgent.startRun(multiAgentId, input));
      setRuns((prev) => [created, ...prev.filter((r) => r.id !== created.id)]);
      setSelectedRunId(created.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId]);

  const stop = useCallback(async (targetRunId?: string) => {
    const id = targetRunId ?? run?.id;
    if (!id) return;
    try {
      await readData(api.multiAgent.stopRun(multiAgentId, id));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId, run?.id]);

  const confirm = useCallback(async (nodeId: string, approved: boolean, note: string, rework = false) => {
    if (!run) return;
    try {
      await readData(api.multiAgent.confirmNode(multiAgentId, run.id, nodeId, approved, note, rework));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId, run]);

  /** 同步節點對話最新回覆並繼續往後流轉下游 */
  const continueNode = useCallback(async (nodeId: string) => {
    if (!run) return;
    try {
      await readData(api.multiAgent.continueNode(multiAgentId, run.id, nodeId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId, run]);

  /** waiting_input 節點：以目前輸出完成或標記失敗 */
  const finishNode = useCallback(async (nodeId: string, outcome: 'complete' | 'fail') => {
    if (!run) return;
    try {
      await readData(api.multiAgent.finishNode(multiAgentId, run.id, nodeId, outcome));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId, run]);

  const isRunning = run?.status === 'running' || run?.status === 'stopping';
  const hasAnyRunning = activeRuns.length > 0;
  return {
    run,
    runs,
    activeRuns,
    selectedRunId: run?.id ?? null,
    selectRun: setSelectedRunId,
    isRunning,
    hasAnyRunning,
    start,
    stop,
    confirm,
    continueNode,
    finishNode,
    error,
    clearError: () => setError(null),
  };
}
