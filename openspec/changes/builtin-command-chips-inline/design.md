## Context

`fix-slash-command-chips` 变更将 `/model` 路由到 Shell 标签的 PTY 执行真实 CLI，但该交互打断 chat 上下文、不符合预期。本变更撤销该路由，让所有 build-in 指令留在 chat 内：选中固化为 Chip、提交后内联渲染结果。

**当前 build-in 指令链路（已核实）：**
- build-in 指令是 CloudCLI 服务端自实现（`server/routes/commands.js` 的 `builtInHandlers`），经 `/api/commands/execute` 返回 `{ type: 'builtin', action, data }`，**不碰真实 CLI binary**。
- 前端 `executeCommand`（`useChatComposerState.ts:331`）收到 `builtin` 结果后调用 `handleBuiltInCommand`（:205）按 `action` 分发：`clear`/`help`/`model`/`cost`/`status`/`memory`/`config`/`rewind`。当前 `/model` 分支把可用模型拼成纯文本 Markdown 消息（:226-233）。
- 选中路径现状（上一个变更后）：`useSlashCommands.selectCommand` 中 `/model` 走 `onRunInShell('/model')` 切到 Shell；其它 build-in（非 skill）走 `executeNonSkillCommand` 即时执行、不固化 Chip。skills 命令走 `onSelectCommand` 固化 Chip。

**结论：** 内联渲染所需的 `executeCommand → handleBuiltInCommand` 链路已存在，本变更主要改前端的「选中固化」与「结果展示」两处。

## Goals / Non-Goals

**Goals:**
- 撤销 `/model` → Shell 路由，`/model` 回到 chat 内联处理。
- 所有 build-in 指令选中（点击 / Enter / Tab）后固化为可删除 Chip，与 skills 一致，可追加文本后回车提交。
- build-in 指令结果在 chat 内联渲染为结构化 UI；首要：`/model` 渲染为可点击选择的模型列表，点击切换模型。

**Non-Goals:**
- 不修改 build-in 指令的服务端实现（`commands.js`）。
- 不让 build-in 指令走真实 CLI binary / PTY（采用「内联实现」语义，沿用 `handleModelSwitch` 本地切换）。
- 不改变 skills / custom 命令的现有 Chip 与执行行为。
- 不必移除 Shell 标签自身的 PTY 注入能力（仅 build-in 指令不再使用它）。

## Decisions

### 决策 1：build-in 指令选中统一固化为 Chip
`useSlashCommands.selectCommand` 中，移除 `/model` 的 `onRunInShell` 分支；将 build-in 指令（含 `/model`，但 `/clear` 等"无参即时"指令见决策 3）改为调用 `onSelectCommand(command)` 固化 Chip，与 skills 同路径。

- **为何**：统一交互、支持追加输入，符合用户「参考 skills 固化 Chip」的诉求。
- **影响**：`isSkillCommand` 当前已把多类视为可固化；需让 build-in（`metadata.type === 'builtin'`）也走固化路径。

### 决策 2：Chip 提交后 build-in 经现有链路执行并内联渲染
Chip + 追加文本提交时走已有的 `handleSubmit` pending 分支 → `executeCommand` → `/api/commands/execute` → `handleBuiltInCommand`。无需新增网络链路。

### 决策 3：即时类 build-in（如 `/clear`）的处理
`/clear`（清空对话）、`/config`（打开设置）这类无参、无需追加输入的指令，固化 Chip 后回车即执行；是否对其跳过 Chip 直接执行，在实现时按体验微调（倾向：仍固化 Chip 以保持统一，回车即触发对应 action）。

### 决策 4：`/model` 内联可选择列表
改造 `handleBuiltInCommand` 的 `model` 分支：不再拼纯文本，而是 `addMessage` 一条带结构化数据的消息（如 `isBuiltinModelList: true` + 模型选项 + 当前模型），由 `MessageComponent` 渲染为可点击列表；点击某项调用 `handleModelSwitch(value)` 切换并标记已选。

- **为何**：用户明确要求 `/model` 展示列表进行选择。
- **复用**：模型选项来自 `shared/modelConstants.js`（与服务端 `/model` 返回的 `available` 一致），切换沿用 `handleModelSwitch`。

### 决策 5：撤销范围
移除 build-in 指令对 `onRunInShell` 的使用。上一个变更新增的 `AppContent`/`MainContent`/`StandaloneShell`/`Shell` 的 `pendingCommand` 注入链路：保留代码（Shell 标签可能另有用途），但 build-in 指令不再触发它。`/model` 在 `handleCommandInputChange` 中精确匹配时也不再 `onRunInShell`。

## Risks / Trade-offs

- **[风险] build-in 与 skill 的固化判定耦合**：`isSkillCommand` 同时判断 skill/custom/model-option。需精确让 build-in 走固化而不误伤 `/clear` 等即时语义。→ **缓解**：以 `metadata.type === 'builtin'` 显式分支，必要时区分"即时 build-in"白名单。
- **[风险] 内联模型列表与消息持久化**：结构化消息需能在会话历史中正确序列化/重渲染。→ **缓解**：用轻量 flag + 数据字段（如 `ChatMessage` 既有的 `[key: string]: unknown`），渲染端容错。
- **[风险] 撤销不彻底**：残留 `/model`→Shell 代码路径造成双重行为。→ **缓解**：集中检查 `onRunInShell` 在 build-in 场景的所有调用点。
- **[权衡] 不走真实 CLi binary**：`/model` 等仍是 CloudCLI 自实现的"务实内联"，与真实 CLI 行为可能有差异；本轮按用户选择采用内联语义。
- **[已修复] 结构化消息的 store 往返**：`/model` 列表消息经 session store 的 `NormalizedMessage` 往返时，若落到通用 `text` kind 会丢失 `modelOptions`（甚至错型导致 `e.map is not a function` 崩溃）。解法：新增客户端专用 `builtin_model_list` kind，在序列化（`chatMessageToNormalized`）与反序列化（`normalizedToChatMessages`）双向显式处理，渲染处加 `Array.isArray` 守卫。注意该 kind 为客户端临时态，服务端 REST 历史不持久化，硬刷新后需重新执行 `/model` 才再现列表（符合临时 UI 语义）。

## Open Questions

- `/clear`、`/config` 这类即时 build-in 是否也固化 Chip（统一）还是保持直接执行（更快）？倾向统一固化，实现时确认体验。
- 除 `/model` 外，`/cost`、`/status` 等是否需要超出现有文本的结构化展示？本轮先保证 Chip 固化 + `/model` 列表，其它沿用文本，按需增强。
