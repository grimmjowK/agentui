/**
 * 各 provider 的有效模型清單（與後端校驗同一來源：/api/providers/:provider/models）。
 */
import { useEffect, useState } from 'react';

import { PROVIDER_IDS, type LLMProvider } from '../../../../shared/providers';
import { api } from '../../../utils/api';
import { readData } from '../utils/fetchJson';

export type ModelOption = { value: string; label: string };
export type ModelsByProvider = Partial<Record<LLMProvider, ModelOption[]>>;

let cache: ModelsByProvider | null = null;
let inFlight: Promise<ModelsByProvider> | null = null;

async function loadAll(): Promise<ModelsByProvider> {
  const entries = await Promise.all(PROVIDER_IDS.map(async (provider) => {
    try {
      const data = await readData<{ models: ModelOption[] }>(api.providerModels(provider));
      return [provider, data.models] as const;
    } catch {
      return [provider, undefined] as const;
    }
  }));
  return Object.fromEntries(entries.filter(([, models]) => models)) as ModelsByProvider;
}

export function useProviderModels(): ModelsByProvider {
  const [models, setModels] = useState<ModelsByProvider>(cache ?? {});
  useEffect(() => {
    if (cache) return;
    inFlight ??= loadAll().then((result) => { cache = result; return result; }).finally(() => { inFlight = null; });
    let alive = true;
    void inFlight.then((result) => { if (alive) setModels(result); });
    return () => { alive = false; };
  }, []);
  return models;
}

export function modelLabel(models: ModelsByProvider, provider: LLMProvider, model: string): string {
  return models[provider]?.find((option) => option.value === model)?.label ?? model;
}
