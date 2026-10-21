# Codex runtime protocol verification

## Tested runtime

2026-10-20, macOS 27.0.1 arm64. Executable:
`/Applications/ChatGPT.app/Contents/Resources/codex`, reported
`0.155.0-alpha.9`. Configuration root: `~/.codex`.
All requests used `app-server --listen stdio://` over actual stdin/stdout,
not `--help` or schema inspection alone. Probes ran in separate temporary
workspaces. No global approval policy or exec policy was changed.

Initialize: `clientInfo: {name: "agentui-probe", version: "1.0"}`,
`capabilities: {experimentalApi: true}`, followed by `initialized`.
Model used for successful turns: the live `model/list` default,
`gpt-6-astra`. An initial attempt with the configured `gpt-5.4` default
failed account entitlement with HTTP 400. `gpt-6` was also rejected.
A model appearing in a configuration file is not evidence it can run.

## Observed capabilities

| Operation | Actual result |
|---|---|
| initialize, model/list | Successful RPC results |
| thread/start, turn/start | Native thread/turn IDs, streamed text and completed turn |
| thread/resume existing ID | Same ID returned |
| thread/resume nonexistent UUID | RPC -32600, no rollout found; no new thread |
| file approval accept | File absent before reply, `APPROVAL_OK` written after reply, same turn completed |
| file approval decline | Item status declined; file absent; same turn completed |
| command approval accept | File absent before reply; command exit 0; file created; same turn completed |
| command approval cancel | Item declined; file absent; turn interrupted |
| turn/interrupt after item start | RPC success, turn/completed interrupted, process exited 0 |
| additional permissions | Not yet exercised; disabled in the chat dispatcher |
| TUI bidirectional resume | TUI resumed original ID and showed prior history; sent TUI_ROUNDTRIP_OK; app-server resumed the same ID and thread/read contained both old and TUI messages |

Sanitized actual messages and injected client decisions are in
[`fixtures/codex`](fixtures/codex). Request IDs retain their actual numeric type.
Command requests advertised `accept`, an exec-policy amendment object, and
`cancel`. The UI intentionally does not offer the policy amendment. It must
not invent `decline` or session-wide approval when these are not advertised.
File requests did not advertise decisions; accept and decline were both
exercised. Expiry refuses the operation using decline or advertised cancel.

An immediate `turn/interrupt` directly after the turn/start reply returned
`no active turn to interrupt`. The chat adapter therefore bounds interruption
and closes the managed process if interruption fails or completion never arrives.
A separate probe waited for item start, then successfully interrupted the active turn and observed its interrupted completion.

## Runtime selection and lifecycle

Chat, terminal, authentication and model discovery resolve `CODEX_CLI_PATH`
first, then ChatGPT.app / Codex.app on macOS, then an absolute executable on
PATH. Invalid explicit configuration fails; no SDK bundled-binary fallback is
used. PTY uses an executable plus argument array. `CODEX_HOME` identifies the
configuration/history root; new child processes snapshot that value. Restart
or reconnect after changing runtime configuration; existing processes are not
hot-swapped. The model cache is scoped to the runtime descriptor.

Chat runs the bidirectional app-server protocol. The terminal runs the native
TUI in a different process using the same executable and explicit thread ID.
This does not replicate App-only UI, connectors, or plugins.

Default mode uses workspace-write/on-request. Accept edits uses
workspace-write/never and cannot request additional permissions. Full access
uses danger-full-access/never only after explicit selection. App approval
cannot override host restrictions. Unknown approval methods fail closed.

Each managed thread has a claim under `CODEX_HOME/agentui-runs`, independent
of UI user and project aliases. Disconnecting a WebSocket does not release it.
Chat releases only after app-server exit; terminal releases on PTY exit. A
second tab cannot take over a connected PTY. Wait for an active chat to finish
or stop it; explicitly disconnect the terminal before sending in chat. Terminal
release signals a history refresh without clearing the chat draft.

Unclean server restarts intentionally retain the disk claim. The error gives
the exact claim directory. Inspect its owner.json and verify the recorded
runtime has exited before manually removing that claim. No stale PID is
blindly killed. Automatic OS identity reconciliation and the richer handoff UI
remain outstanding. External App/terminal processes are outside this lock.

## Acceptance status

The observed version is a protocol test baseline, **not yet a fully accepted
minimum version**. Other versions/platforms, browser approval/handoff, and
other-provider end-to-end regression remain unverified. Unit tests and builds
are reported separately and do not replace these acceptance tests.

## Application adapter smoke test

The actual queryCodex entry emitted one permission_request, accepted its opaque
request ID, created the expected probe file, and emitted exactly one complete.
A synthetic nonnumeric test user exposed a synchronous notification database
error; notification failures are now isolated from the successful turn outcome.

Browser acceptance is blocked: CUA returned `Computer Use permissions are not
granted`; no browser connector was available. This is a computer-control
permission issue, not a filesystem/shell execution restriction. Browser tasks
and other-provider end-to-end tests are not marked passed.

The Codex SDK has no remaining runtime imports and was removed as a dependency.
Other provider SDKs are unchanged.

Latest automated checks (2026-10-21): typecheck passed; build passed;
11 targeted tests passed; lint exited 0 with 341 warnings and no errors;
OpenSpec strict validation passed. Lint warnings were not mass-fixed.
These checks do not imply browser or cross-provider acceptance.

## Terminal bootstrap regression (2026-10-21)

The reported `account/read failed during TUI bootstrap` error was reproduced
without starting a turn: the same App CLI returned `workspace routing discovery
timed out` from `account/read` after 10,009 ms. In the same process,
`thread/read` succeeded for an existing root thread. This isolates the failure
to CLI account/workspace discovery, not missing transcript data or filesystem
permissions. A successful TUI startup has **not** been revalidated after this
failure; the upstream account routing timeout remains unresolved.

Existing-terminal preflight now uses `thread/read` rather than loading the
thread with `thread/resume` in a temporary app-server. This follows the official
[read-only thread API](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming).
A child thread is rejected with its parent ID when available, rather than
silently switching IDs or loading an unloaded v2 child independently. Local
transcript inspection found one child whose `session_meta` contained both a
`parent_thread_id` and a `subagent` source, while the AgentUI database exposed
it as a peer conversation. Codex synchronization now excludes those child
transcripts and removes stale derived index rows without deleting JSONL history.

AgentUI-managed Codex children also discard ambient `CODEX_THREAD_ID`,
`CODEX_SESSION_ID`, and sandbox marker variables inherited from a parent Codex
process. They retain the explicitly selected `CODEX_HOME`. A sanitized native
TUI launch still reproduced the same `account/read` routing timeout, so this
environment fix prevents identity contamination but does not claim to resolve
the upstream routing failure.

When a Codex terminal exits or startup fails, the UI clears its connected state,
keeps the error visible, and allows explicit reconnect. It does not repeatedly
autostart a failing TUI. Account routing timeout gets a targeted diagnostic;
no auth, proxy, or routing configuration is changed. Terminating a failed
startup is acknowledged, preventing an indefinite wait for a nonexistent PTY.
