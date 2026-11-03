import { useCallback, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';
import {
  CLI_PROVIDERS,
  PROVIDER_AUTH_STATUS_ENDPOINTS,
  PROVIDER_INSTALL_ENDPOINTS,
  createInitialProviderAuthStatusMap,
} from '../types';
import type {
  ProviderAuthStatus,
  ProviderAuthStatusMap,
} from '../types';

type ProviderAuthStatusPayload = {
  installed?: boolean;
  authenticated?: boolean;
  email?: string | null;
  method?: string | null;
  error?: string | null;
};

type ProviderAuthStatusApiResponse = {
  success: boolean;
  data: ProviderAuthStatusPayload;
};

const FALLBACK_STATUS_ERROR = 'Failed to check authentication status';
const FALLBACK_UNKNOWN_ERROR = 'Unknown error';

const toErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : FALLBACK_UNKNOWN_ERROR
);

const toProviderAuthStatus = (
  payload: ProviderAuthStatusPayload,
  fallbackError: string | null = null,
): ProviderAuthStatus => ({
  installed: payload.installed ?? Boolean(payload.authenticated),
  authenticated: Boolean(payload.authenticated),
  email: payload.email ?? null,
  method: payload.method ?? null,
  error: payload.error ?? fallbackError,
  loading: false,
});

type UseProviderAuthStatusOptions = {
  initialLoading?: boolean;
};

export function useProviderAuthStatus(
  { initialLoading = true }: UseProviderAuthStatusOptions = {},
) {
  const [providerAuthStatus, setProviderAuthStatus] = useState<ProviderAuthStatusMap>(() => (
    createInitialProviderAuthStatusMap(initialLoading)
  ));

  const setProviderLoading = useCallback((provider: LLMProvider) => {
    setProviderAuthStatus((previous) => ({
      ...previous,
      [provider]: {
        ...previous[provider],
        loading: true,
        error: null,
      },
    }));
  }, []);

  const setProviderStatus = useCallback((provider: LLMProvider, status: ProviderAuthStatus) => {
    setProviderAuthStatus((previous) => ({
      ...previous,
      [provider]: status,
    }));
  }, []);

  const checkProviderAuthStatus = useCallback(async (provider: LLMProvider) => {
    setProviderLoading(provider);

    try {
      const response = await authenticatedFetch(PROVIDER_AUTH_STATUS_ENDPOINTS[provider]);

      if (!response.ok) {
        setProviderStatus(provider, {
          installed: true,
          authenticated: false,
          email: null,
          method: null,
          loading: false,
          error: FALLBACK_STATUS_ERROR,
        });
        return;
      }

      const payload = (await response.json()) as ProviderAuthStatusApiResponse;
      setProviderStatus(provider, toProviderAuthStatus(payload.data));
    } catch (caughtError) {
      console.error(`Error checking ${provider} auth status:`, caughtError);
      setProviderStatus(provider, {
        installed: true,
        authenticated: false,
        email: null,
        method: null,
        loading: false,
        error: toErrorMessage(caughtError),
      });
    }
  }, [setProviderLoading, setProviderStatus]);

  const refreshProviderAuthStatuses = useCallback(async (providers: LLMProvider[] = CLI_PROVIDERS) => {
    await Promise.all(providers.map((provider) => checkProviderAuthStatus(provider)));
  }, [checkProviderAuthStatus]);

  const installProviderCli = useCallback(async (provider: LLMProvider): Promise<boolean> => {
    setProviderAuthStatus((previous) => ({
      ...previous,
      [provider]: {
        ...previous[provider],
        installing: true,
        installSuccess: false,
        error: null,
      },
    }));

    try {
      const response = await authenticatedFetch(PROVIDER_INSTALL_ENDPOINTS[provider], {
        method: 'POST',
      });

      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        data?: ProviderAuthStatusPayload;
        error?: string;
      };

      if (!response.ok || !payload.data) {
        const errorMessage = payload.error || 'Failed to install CLI';
        setProviderAuthStatus((previous) => ({
          ...previous,
          [provider]: {
            ...previous[provider],
            installing: false,
            installSuccess: false,
            error: errorMessage,
          },
        }));
        return false;
      }

      setProviderStatus(provider, {
        ...toProviderAuthStatus(payload.data),
        installing: false,
        installSuccess: true,
      });
      return true;
    } catch (caughtError) {
      setProviderAuthStatus((previous) => ({
        ...previous,
        [provider]: {
          ...previous[provider],
          installing: false,
          installSuccess: false,
          error: toErrorMessage(caughtError),
        },
      }));
      return false;
    }
  }, [setProviderStatus]);

  return {
    providerAuthStatus,
    setProviderAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
    installProviderCli,
  };
}
