/**
 * 多 Agent 列表。側邊欄與頁面共用同一份記憶體快取，任一處修改後兩邊同步。
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { api } from '../../../utils/api';
import type { MultiAgent, MultiAgentKind } from '../types/types';
import { readData } from '../utils/fetchJson';

type State = { items: MultiAgent[]; loaded: boolean; loading: boolean };

let state: State = { items: [], loaded: false, loading: false };
const listeners = new Set<() => void>();
const setState = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export async function refreshMultiAgents(): Promise<void> {
  if (state.loading) return;
  setState({ loading: true });
  try {
    setState({ items: await readData<MultiAgent[]>(api.multiAgent.list()), loaded: true });
  } catch (error) {
    console.error('[multi-agent] list failed', error);
  } finally {
    setState({ loading: false });
  }
}

/** 本地更新單一項目（定義或名稱變更後） */
export function upsertMultiAgentLocal(agent: MultiAgent): void {
  const rest = state.items.filter((item) => item.id !== agent.id);
  setState({ items: [agent, ...rest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
}

export function useMultiAgents() {
  const snapshot = useSyncExternalStore(subscribe, () => state);

  useEffect(() => {
    if (!state.loaded) void refreshMultiAgents();
  }, []);

  const create = useCallback(async (kind: MultiAgentKind, projectId?: string | null) => {
    const agent = await readData<MultiAgent>(api.multiAgent.create({ kind, projectId: projectId ?? undefined }));
    upsertMultiAgentLocal(agent);
    return agent;
  }, []);

  const rename = useCallback(async (id: string, name: string) => {
    const agent = await readData<MultiAgent>(api.multiAgent.update(id, { name }));
    upsertMultiAgentLocal(agent);
  }, []);

  const remove = useCallback(async (id: string) => {
    await readData(api.multiAgent.remove(id));
    setState({ items: state.items.filter((item) => item.id !== id) });
  }, []);

  return { items: snapshot.items, loaded: snapshot.loaded, create, rename, remove, refresh: refreshMultiAgents };
}
