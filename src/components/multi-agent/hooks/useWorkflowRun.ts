/**
 * 工作流執行狀態：支援同一工作流多個並行／歷史 run，依 multi-agent-run 事件按 runId 即時更新。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import { api } from '../../../utils/api';
import type { NodeRunStatus, WorkflowRun } from '../types/types';
import { readData } from '../utils/fetchJson';

export type RunEvent = {
  type: 'multi-agent-run';
  multiAgentId: string;
  runId: string;
  status: WorkflowRun['status'];
  nodeStates?: Record<string, NodeRunStatus>;
  nodeId?: string;
  node?: NodeRunStatus;
};

/** 純函式更新單筆已知 run；若 runId 不在目前清單中回傳 null，由外部觸發一次 reload。 */
export function applyWorkflowRunEvent(current: WorkflowRun[], event: RunEvent): WorkflowRun[] | null {
  const idx = current.findIndex((r) => r.id === event.runId);
  if (idx === -1) return null;
  const target = current[idx];
  const nodeStates = event.nodeStates
    ? event.nodeStates
    : event.nodeId && event.node
      ? { ...target.nodeStates, [event.nodeId]: event.node }
      : target.nodeStates;
  const next = [...current];
  next[idx] = { ...target, status: event.status, nodeStates };
  return next;
}

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
  const requestSeqRef = useRef(0);
  const runsRef = useRef<WorkflowRun[]>(runs);
  runsRef.current = runs;
  const reloadingUnknownRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    try {
      const list = await readData<WorkflowRun[]>(api.multiAgent.listRuns(multiAgentId));
      if (seq !== requestSeqRef.current) return;
      setRuns(list);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError((err as Error).message);
    } finally {
      if (seq === requestSeqRef.current) reloadingUnknownRef.current = null;
    }
  }, [multiAgentId]);

  // 切換工作流時重置選中 runId（除非 URL 帶了 runId）
  useEffect(() => {
    requestSeqRef.current += 1;
    reloadingUnknownRef.current = null;
    setRuns([]);
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
    if (!runsRef.current.some((r) => r.id === event.runId)) {
      // 新的 run（例如其他分頁開始的）：不在 state updater 內觸發副作用，並合併同一未知 runId 的重複拉取
      if (reloadingUnknownRef.current !== event.runId) {
        reloadingUnknownRef.current = event.runId;
        void reload();
      }
      return;
    }
    setRuns((current) => applyWorkflowRunEvent(current, event) ?? current);
  }, [latestMessage, multiAgentId, reload]);

  const visibleRuns = runs.filter((r) => !r.isArchived);
  const run = (selectedRunId ? runs.find((r) => r.id === selectedRunId) : null) ?? visibleRuns[0] ?? null;
  const activeRuns = visibleRuns.filter((r) => r.status === 'running' || r.status === 'stopping');

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

  const deleteRun = useCallback(async (runId: string, options: { force?: boolean } = {}) => {
    setError(null);
    try {
      const res = await readData<{ id: string; archived?: boolean; deleted?: boolean }>(
        api.multiAgent.deleteRun(multiAgentId, runId, options),
      );
      setRuns((prev) => {
        const next = res.deleted
          ? prev.filter((r) => r.id !== runId)
          : prev.map((r) => (r.id === runId ? { ...r, isArchived: true } : r));
        if (selectedRunId === runId) {
          const fallback = next.find((r) => !r.isArchived);
          setSelectedRunId(fallback?.id ?? null);
        }
        return next;
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId, selectedRunId]);

  const restoreRun = useCallback(async (runId: string) => {
    setError(null);
    try {
      await readData(api.multiAgent.restoreRun(multiAgentId, runId));
      setRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, isArchived: false } : r)));
      setSelectedRunId(runId);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId]);

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
    deleteRun,
    restoreRun,
    confirm,
    continueNode,
    finishNode,
    error,
    clearError: () => setError(null),
  };
}
