import type { LLMProvider } from '../../types/app';

export type SkillScope = 'user' | 'project';

export type SkillItem = {
  name: string;
  scope: SkillScope;
  filename: string;
  content: string;
};

export type SkillProvider = Extract<LLMProvider, 'claude' | 'gemini'>;

export const SKILLS_SUPPORTED_PROVIDERS: ReadonlySet<LLMProvider> = new Set(['claude', 'gemini']);

export const isSkillProvider = (provider: LLMProvider): provider is SkillProvider =>
  SKILLS_SUPPORTED_PROVIDERS.has(provider);
