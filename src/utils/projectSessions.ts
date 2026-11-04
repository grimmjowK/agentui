import { PROVIDER_IDS } from '../../shared/providers';
import type { LLMProvider, Project, ProjectSession } from '../types/app';

export type SessionsByProvider = Partial<Record<LLMProvider, ProjectSession[]>>;

/**
 * 讀取專案的會話：指定 provider 時回傳該家的清單，不指定時回傳所有 provider 的會話，
 * 並在每筆帶上 `__provider`（design D3：集中所有 sessionsByProvider 的讀取）。
 */
export function getProjectSessions(project: Pick<Project, 'sessionsByProvider'>, provider?: LLMProvider): ProjectSession[] {
  const byProvider = project.sessionsByProvider ?? {};
  const providers = provider ? [provider] : PROVIDER_IDS;
  return providers.flatMap((id) => (byProvider[id] ?? []).map((session) => ({ ...session, __provider: id })));
}

/** 對每個 provider 的清單套用同一個轉換，回傳新的 sessionsByProvider。 */
export function mapProjectSessions(
  byProvider: SessionsByProvider | undefined,
  map: (sessions: ProjectSession[], provider: LLMProvider) => ProjectSession[],
): SessionsByProvider {
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, map(byProvider?.[id] ?? [], id)]));
}
