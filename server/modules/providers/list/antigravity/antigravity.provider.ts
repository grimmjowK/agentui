import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { AntigravityProviderAuth } from '@/modules/providers/list/antigravity/antigravity-auth.provider.js';
import { AntigravityMcpProvider } from '@/modules/providers/list/antigravity/antigravity-mcp.provider.js';
import { AntigravitySessionSynchronizer } from '@/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.js';
import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { AntigravitySkillsProvider } from '@/modules/providers/list/antigravity/antigravity-skills.provider.js';
import type {
  IProviderAuth,
  IProviderMcp,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

export class AntigravityProvider extends AbstractProvider {
  readonly auth: IProviderAuth = new AntigravityProviderAuth();
  readonly mcp: IProviderMcp = new AntigravityMcpProvider();
  readonly skills: IProviderSkills = new AntigravitySkillsProvider();
  readonly sessions: IProviderSessions = new AntigravitySessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new AntigravitySessionSynchronizer();

  constructor() {
    super('antigravity');
  }
}
