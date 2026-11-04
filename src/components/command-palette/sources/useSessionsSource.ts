import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider, Project } from '../../../types/app';
import { getProjectSessions } from '../../../utils/projectSessions';

import { useApiSource } from './useApiSource';

export type SessionResult = {
  id: string;
  label: string;
  provider?: LLMProvider;
};

type SessionsResponse = Pick<Project, 'sessionsByProvider'>;

export function useSessionsSource(projectId: string | undefined, enabled: boolean) {
  return useApiSource<SessionResult, SessionsResponse>({
    enabled: enabled && !!projectId,
    deps: [projectId],
    fetcher: (signal) => {
      const params = new URLSearchParams({ limit: '50', offset: '0' });
      return authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectId!)}/sessions?${params.toString()}`,
        { signal },
      );
    },
    parse: (data) => {
      return getProjectSessions(data).map<SessionResult>((s) => ({
        id: s.id,
        label: (s.title || s.summary || s.name || s.id) as string,
        provider: s.__provider,
      }));
    },
  });
}
