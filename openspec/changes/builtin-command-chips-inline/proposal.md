## Why

上一个变更（`fix-slash-command-chips`）把 `/model` 路由到 Shell 终端标签页执行。实际使用后发现这种设计极不合理：用户在 chat 中输入 `/model` 却被切走到 terminal，打断了对话上下文，不符合预期。

用户真正想要的是：**所有 build-in 指令都留在 chat 内、与 CLI 能力交互，但不切到 terminal**。具体两点：(1) build-in 指令选中/回车后应像 skills 命令那样固化为可删除 Chip，便于追加输入；(2) 提交 build-in 指令后，结果在 chat 内联渲染为更友好的 UI，例如 `/model` 展示可点击选择的模型列表，而不是纯文本或跳转终端。

## What Changes

- **撤销 `/model` 路由到 Shell**：`/model` 不再切到 Shell 标签注入真实 CLI；回到 chat 内联处理。移除上一个变更引入的 chat→Shell 注入链路对 build-in 指令的使用（PTY 注入机制本身保留给 Shell 标签自身）。
- **build-in 指令统一固化为 Chip**：所有 build-in 指令（`/model`、`/help`、`/cost`、`/status`、`/memory`、`/config`、`/rewind`、`/clear`）从下拉菜单选中（点击 / Enter / Tab）后，固化为输入区上方的可删除 Chip，与 skills 命令行为一致，允许追加文本后回车提交。
- **build-in 指令结果内联优化展示**：提交 build-in 指令到服务端 build-in 实现后，结果在 chat 内联渲染为结构化 UI。首要场景：`/model` 渲染为可点击选择的模型列表，点击某项即切换模型（沿用现有 `handleModelSwitch` 本地切换语义，不走真实 CLI binary / PTY）。

## Capabilities

### New Capabilities
- `builtin-command-inline-display`: 定义 build-in 指令提交后在 chat 内联渲染结果的契约，包括 `/model` 的可选择模型列表等结构化展示与交互。

### Modified Capabilities
- `slash-command-token`: 将「选中命令固化为 Chip」明确扩展到 build-in 指令（此前 build-in 走即时执行、不固化 Chip）；并撤销 `/model` 路由到 Shell 终端的行为，改为 chip 固化 + chat 内联处理。

## Impact

- 前端 hooks：`src/components/chat/hooks/useSlashCommands.ts`（build-in 指令选中改为固化 Chip，移除 `/model` 的 `onRunInShell` 路由）、`src/components/chat/hooks/useChatComposerState.ts`（build-in 指令经 Chip 提交后的执行与结果渲染，`handleBuiltInCommand` 的 `/model` 分支改为内联列表）。
- 前端组件：`src/components/chat/view/subcomponents/`（新增/调整 build-in 结果的内联渲染组件，如模型选择列表）、`MessageComponent.tsx`（渲染结构化 build-in 结果）。
- 撤销影响：上一个变更新增的 `onRunInShell` 在 chat→Shell 之间用于 build-in 指令的链路（`AppContent`/`MainContent`/`StandaloneShell`/`Shell` 的 `pendingCommand` 注入）不再被 build-in 指令使用；PTY 注入能力是否完全移除或保留给其它用途，在 design 中决定。
- 不改变 build-in 指令的服务端实现（`server/routes/commands.js`），仅改变前端的固化与展示方式。
