import type { LLMProvider } from '../../types/app';

export type ProviderAuthStatus = {
  installed: boolean;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
  installing?: boolean;
  installSuccess?: boolean;
};

export type ProviderAuthStatusMap = Record<LLMProvider, ProviderAuthStatus>;

export const CLI_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'gemini', 'antigravity'];

export const PROVIDER_AUTH_STATUS_ENDPOINTS: Record<LLMProvider, string> = {
  claude: '/api/providers/claude/auth/status',
  cursor: '/api/providers/cursor/auth/status',
  codex: '/api/providers/codex/auth/status',
  gemini: '/api/providers/gemini/auth/status',
  antigravity: '/api/providers/antigravity/auth/status',
};

export const PROVIDER_INSTALL_ENDPOINTS: Record<LLMProvider, string> = {
  claude: '/api/providers/claude/install',
  cursor: '/api/providers/cursor/install',
  codex: '/api/providers/codex/install',
  gemini: '/api/providers/gemini/install',
  antigravity: '/api/providers/antigravity/install',
};

export const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: { installed: true, authenticated: false, email: null, method: null, error: null, loading },
  cursor: { installed: true, authenticated: false, email: null, method: null, error: null, loading },
  codex: { installed: true, authenticated: false, email: null, method: null, error: null, loading },
  gemini: { installed: true, authenticated: false, email: null, method: null, error: null, loading },
  antigravity: { installed: true, authenticated: false, email: null, method: null, error: null, loading },
});
