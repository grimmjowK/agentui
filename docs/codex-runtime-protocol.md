# Codex runtime protocol verification

> 本文档记录两批工作：
> 1. `unify-codex-runtime-and-approvals` 变更在 0.155-alpha 上的初始协议实测（下方"Tested runtime"
>    起至"Application adapter smoke test"）。
> 2. `stabilize-codex-app-server-runtime` 变更在 0.163.0 上的稳定性修复（文末"0.163.0 schema
>    addendum"与"daemon / proxy 子命令调研"两节）：版本门禁改最低版本比较、审批决定过滤兜底、
>    异常锁诊断与显式恢复、daemon/proxy 调研。两个变更范围不同，审阅时请按节区分。

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

## 0.163.0 schema addendum (2026-10-22)

本机 homebrew `codex-cli 0.163.0` 用 `codex app-server generate-json-schema` 重新生成协议
schema，与上文 0.155-alpha 的实测记录对照（本节为新增记录，不替换上文历史）。

### 版本门禁调整

原实现用精确字符串 `codex-cli 0.155.0-alpha.9` 判定 `protocol-tested`，导致本机 ChatGPT.app
实际回报的 `0.155.0-alpha.9.2` 与 homebrew `0.163.0` 都被判为 `unverified` 并被 `queryCodex`
直接拒绝。现改为最低已验证版本比较（基线 `0.155.0`，忽略 `-alpha.N` 预发布后缀），新增
`unsupported` 状态（版本号无法解析）。`unsupported` 仍拒绝进入聊天；`unverified`（低于基线但
可解析，或非 darwin 平台）改为继续尝试运行并发一条 `warning` 级 `task_notification`。

### 审批决定类型差异

| 审批方法 | 0.163.0 schema 的决定集合 | agentui 处理 |
|---|---|---|
| `item/commandExecution/requestApproval` | `accept` / `acceptForSession` / `decline` / `cancel` + 对象型 `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment` | 仅支持四个简单枚举；两个对象型决定需要额外 UI 展示策略修正内容，暂不支持而过滤 |
| `item/fileChange/requestApproval` | `accept` / `acceptForSession` / `decline` / `cancel` | 同上，仅简单枚举 |
| `item/permissions/requestApproval` | 回复体为 `permissions` / `scope` / `strictAutoReview` | 维持 `accept`→授予请求的 permissions、`decline`→空 permissions |

对象型决定（`acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment`）继续过滤，理由：
它们携带"建议的 execpolicy / 网络策略修正"，需要专门 UI 让用户审阅修正内容后再决定是否采纳，
超出本次范围，也符合原 proposal「不默认放宽权限」。新增兜底：当某请求 `availableDecisions` 经
过滤后为空（只提供了对象型决定），回退为仅 `['decline']` 并记录一条告警日志，避免产出无可选项
的审批卡片。

## daemon / proxy 子命令调研（2026-10-22, 0.163.0）

`codex app-server` 在 0.163.0 新增了 `daemon` 和 `proxy` 两个子命令（0.155-alpha 时期没有），
本机 `--help` 实测结论：

- `daemon`：管理**单例**的本地 app-server 后台进程，子命令为 `bootstrap`（为 SSH 场景安装
  常驻管理）、`start`/`stop`/`restart`、`update`、`enable-remote-control`/`disable-remote-control`、
  `version`。定位是"一台机器一个常驻 app-server + 远程/SSH 控制"的进程生命周期管理。
- `proxy`：把 stdio 字节代理到**正在运行的** app-server 控制 socket（`--sock <path>`）。定位是
  "多个 client 连到同一个 daemon"的连接转发。

**结论：本变更不复用，`ownership.ts` 自建锁保留。** 理由：
1. `daemon`/`proxy` 解决的是"进程共享与远程接入"，不是"同一 thread 同时只有一个写入端"。它们
   没有暴露 per-thread 的写入互斥语义——多个 client 通过 proxy 连到同一个 daemon 后，谁能写
   某个 thread 仍需上层自己约束，正是 `ownership.ts` 在做的事。
2. `daemon` 是单例全局进程，与 agentui 现有"按 userId/project/thread 隔离、每个受管 thread 一个
   app-server 子进程"的模型不一致，切换过去是架构级改动。
3. `ownership.ts` 的双重进程身份校验 + 原子回收已覆盖异常退出边界；用 daemon 替换需要同等严谨地
   验证其并发语义，超出本变更"修复合并即不可用问题"的范围。

记为后续可选项：若将来要支持 SSH/远程接入或减少多会话的进程开销，可重新评估基于单例 daemon +
proxy 的架构，届时需要单独设计 per-thread 写入互斥如何在共享 daemon 上成立。
