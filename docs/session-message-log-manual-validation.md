# Session Message Log Manual Validation

This checklist validates the durable chat transcript against the live view.
Run it once before enabling the feature flag as a baseline and again after the
flag is enabled.

## Setup

1. Start the app with `npm run dev`.
2. Open the same session on a browser page that can be refreshed.
3. In DevTools, keep a console snippet that samples the visible message rows
   every 300 ms and reports duplicate adjacent `data-message-id` values.
4. Record provider, session id, browser, commit, and timestamp.

## Sample loop

Use a simple request followed by at least one tool call. For each provider,
run Claude, Codex, and Antigravity once:

1. Capture the ordered list of message ids, roles, kinds, and visible text
   before starting the request.
2. Say: `Read the package name, then reply with it in one sentence.`
3. While the request runs, refresh once after the first finished tool result.
4. Capture the ordered list again.
5. After completion, refresh once more and capture the ordered list.
6. Compare the three lists item by item. For the post-change run, the exact
   ordered lists must match.

Also cover:

- Abort one run and refresh. The interruption marker must keep the same id
  and position.
- Reject an approval and refresh. The warning must remain in place.
- Send a long response and refresh while text is still streaming. The already
  emitted prefix must appear immediately after reconnect.

## Baseline

Record the pre-change result before enabling the server-read and frontend
switch flags. The automated fixtures already established these contract
baselines:

| Provider | Live/history anchor ids | Known baseline issue |
| --- | --- | --- |
| Claude | Stable for text, thinking, tool call, and tool result | Frontend time-based merge can still reorder retry errors |
| Codex | Stable after deterministic rollout ids | Historical AGENTS.md rows can be merged differently from live rows |
| Antigravity | Stable for text and tool ids | Live tool input is a summary while history contains complete file content |

## Result template

| Provider | Pre-change ordered ids equal after refresh? | Post-change ordered ids equal after refresh? | Notes |
| --- | --- | --- | --- |
| Claude | Not run | Not run | Claude Code executable is not installed on the validation machine; automated mock-SDK coverage passed |
| Codex | Not recorded | Stable suffix matched | Existing finished session `01a1affb-25c1-70a2-a145-72781b2c61d1`; refreshed result had the same visible command suffix with no duplicate adjacent commands |
| Antigravity | Not recorded | No duplicate markers observed | Existing finished session `92657bda-d02e-4171-9492-5f81623ed97d`; Chrome AX exposes different virtualized slices after refresh, so exact visible-list equality needs a browser instrumentation run |
