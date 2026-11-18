/**
 * 工作流執行狀態：進入頁面時還原最近一次 run，之後依 multi-agent-run 事件更新。
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
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRun(await readData<WorkflowRun | null>(api.multiAgent.latestRun(multiAgentId)));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId]);

  // 進入頁面與重新連線時從伺服器還原
  useEffect(() => { void reload(); }, [reload, isConnected]);

  useEffect(() => {
    const event = latestMessage as RunEvent | null;
    if (event?.type !== 'multi-agent-run' || event.multiAgentId !== multiAgentId) return;
    setRun((current) => {
      if (!current || current.id !== event.runId) {
        // 新的 run（例如其他分頁開始的）：重新拉完整快照
        void reload();
        return current;
      }
      const nodeStates = event.nodeStates
        ? event.nodeStates
        : event.nodeId && event.node
          ? { ...current.nodeStates, [event.nodeId]: event.node }
          : current.nodeStates;
      return { ...current, status: event.status, nodeStates };
    });
  }, [latestMessage, multiAgentId, reload]);

  const start = useCallback(async (input = '') => {
    setError(null);
    try {
      setRun(await readData<WorkflowRun>(api.multiAgent.startRun(multiAgentId, input)));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId]);

  const stop = useCallback(async () => {
    if (!run) return;
    try {
      await readData(api.multiAgent.stopRun(multiAgentId, run.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [multiAgentId, run]);

  const confirm = useCallback(async (nodeId: string, approved: boolean, note: string) => {
    if (!run) return;
    try {
      await readData(api.multiAgent.confirmNode(multiAgentId, run.id, nodeId, approved, note));
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
  return { run, isRunning, start, stop, confirm, finishNode, error, clearError: () => setError(null), setRun };
}
