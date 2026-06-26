## Why

斜杠命令的「命令 Chip」交互（曾在 `slash-command-token` 中定义并实现）发生了回归：从下拉菜单选中命令后不再固化为可删除的 Chip，且换行追加的内容未随命令发送给 CLI（根因：选中路径调用 `insertCommandIntoInput` 插入裸文本而非 `onSelectCommand` 固化 Chip；`executeCommand` 的参数正则缺少 dotAll 标志，丢弃换行后的文本）。

此外，chat 侧的「内置命令」（`/model`、`/help`、`/clear` 等）其实是 CloudCLI UI 在服务端 `server/routes/commands.js` 自行重新实现的**假命令**，走 `/api/commands/execute` HTTP 接口，**完全不与真实 CLI 进程交互**——例如 `/model` 只是读取 `shared/modelConstants.js` 的硬编码列表切换本地设置。用户希望交互式内置命令（如 `/model`）能吻合 CLI 在终端中的真实行为：由真实 CLI 进程返回交互式选择列表，UI 可视化展示并把选择回传给该进程。

值得注意：**Shell 标签页已经实现了这套真实交互**——`Shell.tsx` 的 `checkBufferForPrompt` 扫描真实 CLI 经 PTY（`node-pty`）输出的提示模式（`❯ N. label` + `esc to cancel` / `enter to select`），渲染可点击选项按钮，点击后通过 `sendInput(opt.number)` 写回真实 CLI 的 stdin。chat 与 Shell 是 `MainContent` 中的同级标签页，但 chat 侧没有复用这条 PTY 链路。

## What Changes

- **修复 Chip 固化回归**：所有从下拉选项框选中的 `/` 命令（点击 / Enter / Tab）固化为输入区上方的可删除 Chip，而不是插入裸文本或立即执行。
- **修复追加文本丢失**：Chip 存在时换行/追加的文本随命令一起组装并发送给 CLI（修复 `executeCommand` 参数正则的 dotAll 缺失）。
- **交互式内置命令吻合真实 CLI（复用 Shell PTY 链路）**：让交互式内置命令（首期为 `/model`）不再走服务端假实现，而是经由 Shell 已有的 PTY 链路在真实 CLI 进程上执行；复用 `checkBufferForPrompt` 的提示解析与「选项按钮 → 写回 stdin」机制，使 chat 侧也能可视化展示并选择 CLI 返回的交互式列表。

## Capabilities

### New Capabilities
- `cli-interactive-selection`: 定义当真实 CLI 进程（经 PTY）返回交互式选择列表时，UI 的可视化渲染与把用户选择回传给该进程（写回 stdin）的交互契约。复用 Shell 已有的 PTY 提示解析与回传机制。

### Modified Capabilities
- `slash-command-token`: 修复 Chip 固化与追加文本随命令发送的行为；将「选中命令固化为 Chip」明确扩展到所有从下拉选项框选中的 `/` 命令，并以「回车」为统一的选中与发送触发键。

## Impact

- 前端 hooks：`src/components/chat/hooks/useSlashCommands.ts`（选中路径统一调用 `onSelectCommand` 固化 Chip）、`src/components/chat/hooks/useChatComposerState.ts`（`executeCommand` 参数正则 dotAll 修复）。
- Shell 复用：`src/components/shell/view/Shell.tsx` 的 `checkBufferForPrompt` / `cliPromptOptions` / `sendInput` 与 `server/modules/websocket/services/shell-websocket.service.ts` 的 PTY（`init` / `input` / `resize`）链路，作为交互式命令的真实执行通道。
- 交互式命令在 chat 与 PTY 链路之间的路由集成点：`src/components/main-content/view/MainContent.tsx`（chat / shell 标签页）、`server/routes/commands.js`（交互式内置命令不再用假实现）。
- 不改变纯展示类内置命令（`/help`、`/cost` 等）的现有服务端实现；不改变 Chip 对内置即时命令（`/clear` 等）的非 Chip 边界。
