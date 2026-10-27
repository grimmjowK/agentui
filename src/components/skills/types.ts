import type { LLMProvider } from '../../types/app';

// Mirrors the backend ProviderSkillScope contract. `repo` is used by Codex,
// `plugin` by Claude plugins, and `admin`/`system` by Codex system skills.
export type SkillScope = 'user' | 'project' | 'repo' | 'admin' | 'system' | 'plugin';

export type SkillItem = {
  name: string;
  scope: SkillScope;
  filename: string;
  content: string;
};

export type SkillProvider = LLMProvider;

export const SKILLS_SUPPORTED_PROVIDERS: ReadonlySet<LLMProvider> = new Set([
  'claude',
  'cursor',
  'codex',
  'gemini',
  'antigravity',
]);

export const isSkillProvider = (provider: LLMProvider): provider is SkillProvider =>
  SKILLS_SUPPORTED_PROVIDERS.has(provider);
