# Providers Module Guide

This file documents the current provider contract in `server/modules/providers`.
Keep it current whenever provider wiring, skill discovery, or session sync
behavior changes. The goal is that a human or AI agent can add a new provider
without guessing which files need to move.

## Current Provider Shape

Every provider wrapper exposes six facets:

- `auth`
- `mcp`
- `skills`
- `sessions`
- `sessionSynchronizer`
- `runtime`

These correspond to the shared interfaces in `server/shared/interfaces.ts`:

- `IProviderAuth`
- `IProviderMcp`
- `IProviderSkills`
- `IProviderSessions`
- `IProviderSessionSynchronizer`
- `IProviderRuntime`

The services that consume them are:

- `providerAuthService`
- `providerMcpService`
- `providerSkillsService`
- `sessionsService`
- `sessionSynchronizerService`
- `sessionConversationsSearchService` (uses the optional `sessions.extractSearchableMessages`)
- the chat WebSocket (`chat-websocket.service.ts`) and `/api/agent` (use `runtime`)

Current provider ids in this repo are:

- `claude`
- `codex`
- `cursor`
- `antigravity`

The single source of truth is `shared/providers.ts`: `PROVIDER_IDS` (from which
`LLMProvider` is derived) and `PROVIDER_INFO` (capabilities, permission modes,
settings storage key). Adding a row there makes `npm run typecheck` point at
every place that still needs the new id.

## Current File Layout

Each provider lives under its own folder in `server/modules/providers/list/`:

```text
server/modules/providers/list/<provider>/
  <provider>.provider.ts
  <provider>-auth.provider.ts
  <provider>-mcp.provider.ts
  <provider>-skills.provider.ts
  <provider>-sessions.provider.ts
  <provider>-session-synchronizer.provider.ts
  <provider>-runtime.provider.ts
```

The existing provider folders are `claude`, `codex`, `cursor`, and `antigravity`.
Codex and Antigravity also have an event mapper (`codex-item-mapper.ts`,
`antigravity-tool-mapper.ts`) that converts native events and history into
Claude tool shapes, so the chat UI never branches on provider.

## What Each Facet Does

| Facet | Responsibility | Base / Service |
| --- | --- | --- |
| `auth` | Report install/auth state for the provider runtime | `IProviderAuth` -> `providerAuthService` |
| `mcp` | Read, list, write, and remove provider-native MCP config | `McpProvider` -> `providerMcpService` |
| `skills` | Discover provider-native skill markdown files | `SkillsProvider` -> `providerSkillsService` |
| `sessions` | Normalize live events and fetch session history | `IProviderSessions` -> `sessionsService` |
| `sessionSynchronizer` | Scan transcript artifacts and upsert session metadata | `IProviderSessionSynchronizer` -> `sessionSynchronizerService` |
| `runtime` | Start, abort, reconnect and list live runs; optional `steer` and `getPendingApprovals` | `IProviderRuntime` -> chat WebSocket / `/api/agent` |

Optional `sessions` methods:

| Method | Used by | Implemented by |
| --- | --- | --- |
| `extractSearchableMessages(filePath)` | Full-text search. Providers without it are reported in the search `done` event as `unsearchableProviders`. | Claude, Codex, Antigravity |
| `listArtifacts(sessionId)` | `GET /api/providers/sessions/:sessionId/artifacts` (returns `[]` when missing). Must keep every file inside the provider's artifact root (realpath check). | Antigravity (`brain/<id>/*.md`) |

`runtime` rules:

- `abort` returns `{ ok, emitsTerminal }`. Set `emitsTerminal: true` only when the
  runtime itself sends the terminal `complete`; the dispatcher sends one otherwise,
  so every abort produces exactly one.
- `steer(sessionId, userId, text)` (Codex only) must check owner, run state and
  current turn before calling the CLI, and must never fail the running turn.
- `getPendingApprovals(userId, sessionId?)` returns only that user's items; without
  `sessionId` it lists all sessions (global approval inbox).
`sessions` and `sessionSynchronizer` are separate concerns:

- `sessions` handles runtime event normalization and history fetches.
- `sessionSynchronizer` handles file-backed session indexing into `sessionsDb`.

## How To Add A Provider

1. Add the provider id everywhere it is part of the contract.

- Add a row to `PROVIDER_IDS` and `PROVIDER_INFO` in `shared/providers.ts`;
  `LLMProvider` on both sides derives from it. Run `npm run typecheck` and fix
  every reported spot.
- Update `server/modules/providers/provider.routes.ts`.
- Update `server/index.js` if the provider needs runtime boot or shutdown wiring.
- Update `shared/modelConstants.js` if the provider appears in UI provider pickers.
- Update `src/components/chat/hooks/useChatProviderState.ts` and
  `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx` if
  the provider should be selectable in chat.
- Update `src/components/provider-auth/view/ProviderLoginModal.tsx` if the
  provider has a login/setup flow.

2. Create the wrapper class.

- Add `server/modules/providers/list/<provider>/<provider>.provider.ts`.
- Extend `AbstractProvider`.
- Expose readonly `auth`, `mcp`, `skills`, `sessions`, and `sessionSynchronizer`.
- Call `super('<provider>')`.

3. Implement auth.

- Return a full `ProviderAuthStatus`.
- Treat normal `not installed` / `not authenticated` states as data, not exceptions.
- Keep provider-specific credential discovery inside the auth provider.
- If the provider has no auth step, return a stable unauthenticated or not-installed status instead of omitting the facet.

4. Implement MCP.

- Extend `McpProvider`.
- Pass the supported scopes and transports to `super(...)`.
- Implement the four required methods:
  - `readScopedServers(...)`
  - `writeScopedServers(...)`
  - `buildServerConfig(...)`
  - `normalizeServerConfig(...)`
- Use the shared validation and normalization behavior from `McpProvider`.
- Keep the provider-specific config format local to the provider implementation.

Current MCP formats in this repo are:

| Provider | User / Project Storage | Supported Scopes | Supported Transports |
| --- | --- | --- | --- |
| Claude | `.mcp.json` in user / local / project locations | `user`, `local`, `project` | `stdio`, `http`, `sse` |
| Codex | `.codex/config.toml` | `user`, `project` | `stdio`, `http` |
| Cursor | `.cursor/mcp.json` | `user`, `project` | `stdio`, `http` |
| Antigravity | `<config root>/mcp.json`, `<workspace>/.agents/mcp.json` | `user`, `project` | `stdio`, `http` |

5. Implement skills.

- Extend `SkillsProvider`.
- Implement `getSkillSources(workspacePath)`.
- Return the actual discovery roots for the provider.
- Skills are discovered from `SKILL.md` files.
- `readProviderSkillMarkdownDefinition(...)` reads front matter `name` and `description`.
- If `name` is missing, the parent directory name is used as a fallback.
- Use `recursive: true` only when the provider stores skills in nested trees.
- Keep the emitted `command` string aligned with the provider's real skill syntax.

Current skill discovery roots are:

| Provider | User Roots | Project / Repo Roots | Prefix | Notes |
| --- | --- | --- | --- | --- |
| Claude | `~/.claude/skills` | `<workspace>/.claude/skills` | `/` | Also discovers Claude plugin skills from enabled plugin installs. Command skills live under `commands/`; markdown skills live under `skills/` and are scanned recursively. |
| Codex | `~/.agents/skills`, `~/.codex/skills/.system`, `/etc/codex/skills` | `<workspace>/.agents/skills`, `path.dirname(workspacePath)/.agents/skills`, topmost git root `.agents/skills` | `$` | Overlapping roots are deduplicated before scanning. |
| Cursor | `~/.cursor/skills` | `<workspace>/.cursor/skills`, `<workspace>/.agents/skills` | `/` | Uses slash-style commands. |
| Antigravity | `<config root>/skills`, `~/.agents/skills` | `<workspace>/.agents/skills`, `<workspace>/.gemini/antigravity/skills` | `/` | Uses slash-style commands. |

Command forms currently used by the providers are:

- Claude user/project skills: `/skill-name`
- Claude plugin skills: `/plugin-name:skill-name`
- Codex skills: `$skill-name`
- Cursor skills: `/skill-name`
- Antigravity skills: `/skill-name`

6. Implement sessions.

- Implement `normalizeMessage(raw, sessionId)` and `fetchHistory(sessionId, options)`.
- Use `createNormalizedMessage(...)` and `generateMessageId(...)` for emitted messages.
- Keep normalized message ids unique. If one raw event produces multiple text
  parts, append a discriminator so ids do not collide.
- Keep pagination consistent:
  - `limit: null` means unbounded/full history.
  - `limit: 0` means an empty page.
  - always return `total`, `hasMore`, `offset`, and `limit` when paginating.
- Sanitize any filesystem-derived ids before using them in file or database paths.
- Do not assume a provider's history format matches another provider's format.

7. Implement session synchronization.

- Implement `synchronize(since?: Date)` to scan provider artifacts and upsert
  sessions into `sessionsDb`.
- Implement `synchronizeFile(filePath)` for single-file watcher updates.
- Use the existing helpers when they fit:
  - `buildLookupMap(...)`
  - `extractFirstValidJsonlData(...)`
  - `findFilesRecursivelyCreatedAfter(...)`
  - `normalizeSessionName(...)`
  - `readFileTimestamps(...)`
- Make the sync resilient to partial, malformed, or missing provider files.
- The orchestration service runs every provider synchronizer independently and
  advances that provider's own cursor (`app_config` key `scan_cursor:<provider>`)
  only when it succeeds; one failing provider does not hold back the others.
- Projects expose sessions grouped as `sessionsByProvider[<provider>]`; do not add
  per-provider `xxxSessions` fields.

Current session sync roots are:

| Provider | Scan Roots | Metadata Helpers / Notes |
| --- | --- | --- |
| Claude | `~/.claude/projects/**/*.jsonl` | Uses `~/.claude/history.jsonl` for name lookup and the trailing `ai-title`, `last-prompt`, or `custom-title` entries for title recovery. |
| Codex | `~/.codex/sessions/**/*.jsonl` | Uses `~/.codex/session_index.jsonl` for title lookup and the last `task_complete` message for a fallback title. |
| Cursor | `~/.cursor/projects/**/*.jsonl` | Uses sibling `worker.log` to recover `workspacePath`, then derives the session title from the first user prompt. |
| Antigravity | `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl` (also `~/.gemini/antigravity/brain`, `$ANTIGRAVITY_HOME/brain`) | The brain directory name is the session id; the title comes from `conversation_summaries.db` when present. |

8. Register the provider.

- Add the new provider class to `server/modules/providers/provider.registry.ts`.
- Update `server/modules/providers/provider.routes.ts` provider parsing.
- Add `<provider>-runtime.provider.ts` implementing `IProviderRuntime` and expose it as `runtime`.
- If the provider introduces a new service or lifecycle hook, export it from the module entrypoint that consumes providers.

9. Wire runtime and UI surfaces outside the providers module when needed.

Live chat runs go through `runtime` automatically (the chat WebSocket and
`/api/agent` dispatch via `providerRegistry`). Only touch `server/index.js` if
the runtime needs boot or shutdown wiring.

If the provider is visible in the UI, update:

- `shared/modelConstants.js`
- `src/components/chat/hooks/useChatProviderState.ts`
- `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx`
- `src/components/provider-auth/view/ProviderLoginModal.tsx`

## Minimal Wrapper Template

```ts
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { <Provider>ProviderAuth } from './<provider>-auth.provider.js';
import { <Provider>McpProvider } from './<provider>-mcp.provider.js';
import { <Provider>SkillsProvider } from './<provider>-skills.provider.js';
import { <Provider>SessionsProvider } from './<provider>-sessions.provider.js';
import { <Provider>SessionSynchronizer } from './<provider>-session-synchronizer.provider.js';
import { <Provider>RuntimeProvider } from './<provider>-runtime.provider.js';
import type {
  IProviderAuth,
  IProviderMcp,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

export class <Provider>Provider extends AbstractProvider {
  readonly auth: IProviderAuth = new <Provider>ProviderAuth();
  readonly mcp: IProviderMcp = new <Provider>McpProvider();
  readonly skills: IProviderSkills = new <Provider>SkillsProvider();
  readonly sessions: IProviderSessions = new <Provider>SessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer =
    new <Provider>SessionSynchronizer();
  readonly runtime: IProviderRuntime = new <Provider>RuntimeProvider();

  constructor() {
    super('<provider>');
  }
}
```

## Minimal Skills Template

```ts
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

export class <Provider>SkillsProvider extends SkillsProvider {
  constructor() {
    super('<provider>');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.<provider>', 'skills'),
        commandPrefix: '/',
      },
    ];
  }
}
```

## Minimal Session Sync Template

```ts
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

export class <Provider>SessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(since?: Date): Promise<number> {
    return 0;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    return null;
  }
}
```

## AI Prompt Template

Use this prompt when asking an AI agent to add a provider:

```text
Add a new provider "<provider>" using the current provider module architecture.

Requirements:
1) Create:
   - server/modules/providers/list/<provider>/<provider>.provider.ts
   - server/modules/providers/list/<provider>/<provider>-auth.provider.ts
   - server/modules/providers/list/<provider>/<provider>-mcp.provider.ts
   - server/modules/providers/list/<provider>/<provider>-skills.provider.ts
   - server/modules/providers/list/<provider>/<provider>-sessions.provider.ts
   - server/modules/providers/list/<provider>/<provider>-session-synchronizer.provider.ts
   - server/modules/providers/list/<provider>/<provider>-runtime.provider.ts
2) Register in:
   - server/modules/providers/provider.registry.ts
   - server/modules/providers/provider.routes.ts
   - shared/providers.ts PROVIDER_IDS / PROVIDER_INFO
3) Mirror the nearest existing provider implementation for file naming, style,
   and error handling.
4) Implement skills support with SkillsProvider and the current skill roots.
5) Implement session synchronization if the provider stores transcript files.
6) Ensure sessions use unique ids, safe path handling, and correct pagination.
7) Keep `sessions` and `sessionSynchronizer` separate.
8) Run:
   - npx eslint <touched files>
   - npx tsc --noEmit -p server/tsconfig.json
```

## Validation

After adding or changing a provider, run the relevant checks:

```bash
npx eslint server/modules/providers/**/*.ts server/shared/types.ts server/shared/interfaces.ts
npx tsc --noEmit -p server/tsconfig.json
```

Useful tests in this repo:

- `server/modules/providers/tests/mcp.test.ts`
- `server/modules/providers/tests/skills.test.ts`

If you touch sessions or session synchronization, add or update focused tests
alongside the implementation.

## Common Mistakes

- Adding provider files but forgetting `provider.registry.ts` or
  `provider.routes.ts`.
- Hardcoding a provider list instead of reading `PROVIDER_IDS` / `PROVIDER_INFO`.
- Mapping a provider's new tool in the frontend instead of its backend mapper.
- Omitting `skills` or `sessionSynchronizer` from the wrapper.
- Returning duplicate normalized message ids for split content.
- Treating `limit === 0` as unbounded history.
- Building file paths from raw session ids without validation.
- Hardcoding a skill root without checking the provider's actual discovery rules.
- Forgetting that Claude plugin skills are discovered differently from normal
  user/project skill folders.
- Assuming one provider's MCP config file format works for the others.


For chat messages, the single source of truth is `session_messages`.
`LoggingWriter` assigns the display `seq` before forwarding live messages.
Provider transcript files are used only to import missing sessions and to
supplement fields (for example the full Antigravity tool input) during the
server-side reconciliation step. Cursor currently has no stable live/history id
contract, so a non-empty Cursor log is never reconciled against its history.

