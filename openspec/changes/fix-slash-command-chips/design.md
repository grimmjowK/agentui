## Context

本变更包含两部分：（1）修复已交付的斜杠命令 Chip 交互回归；（2）让交互式内置命令吻合真实 CLI 在终端的行为。

**Chip 回归根因**（已定位）：
- `useSlashCommands` 已接收 `onSelectCommand`（其实现 `handleSelectCommand` 会 `setPendingCommand` 固化 Chip），但两条选中路径（`selectCommandFromKeyboard`、`handleCommandSelect`）都改调了 `insertCommandIntoInput`，把命令文本插入 textarea，Chip 因此不再出现。
- `executeCommand` 的参数正则 `${name}\s*(.*)` 缺少 `s`（dotAll）标志，换行后的追加文本被丢弃。

**真实 CLI 交互的现状与关键发现**：
- chat 侧「内置命令」是 CloudCLI UI 在 `server/routes/commands.js` 的 `builtInHandlers` 里**自行重新实现的假命令**，走 `/api/commands/execute` HTTP 接口，不碰真实 CLI 进程。`/model` 只是读硬编码模型列表切换本地设置。
- chat 侧的 provider 调用（`queryClaudeSDK`、`spawnGemini` 等）是**一次性非交互**的，没有持久 stdin，无法接收方向键/选择回传。
- **Shell 标签页已实现真实交互**：`server/modules/websocket/services/shell-websocket.service.ts` 用 `node-pty` 跑真实 CLI 进程，支持 `init` / `input`（原始按键，含方向键）/ `resize`，会话按 `projectPath_sessionId` 复用、断线 30 分钟内可重连。前端 `Shell.tsx` 的 `checkBufferForPrompt` 扫描 PTY 输出中的提示模式（`❯ N. label` + `esc to cancel` / `enter to select` 页脚），渲染可点击选项按钮，点击后 `sendInput(opt.number)` 写回真实 CLI stdin，并提供 Esc 取消。
- chat 与 Shell 是 `MainContent.tsx` 中的同级标签页（`activeTab === 'chat' | 'shell'`）。

结论：真实交互能力**已存在于 Shell 链路**，本变更的核心是**复用**它，而非新建一套 stdin 基础设施。

## Goals / Non-Goals

**Goals:**
- 修复 Chip 固化回归：所有从下拉选项框选中的 `/` 命令（点击 / Enter / Tab）固化为可删除 Chip。
- 修复换行追加文本随命令发送（dotAll）。
- 让交互式内置命令（首期 `/model`）经由 Shell 已有的 PTY 链路在真实 CLI 进程上执行，并复用 `checkBufferForPrompt` 的提示解析 + 选项按钮 + 写回 stdin 机制实现可视化选择。

**Non-Goals:**
- 不为 chat 侧新建独立的 stdin / 交互协议（明确复用 Shell PTY 链路）。
- 不改造纯展示类内置命令（`/help`、`/cost` 等）的服务端实现。
- 首期不把所有内置命令都接入真实 CLI，只覆盖会触发交互提示的命令（先 `/model` 验证）。
- 不改变 Chip 对内置即时命令（`/clear` 等）的非 Chip 即时执行边界。

## Decisions

### 决策 1：选中命令统一走 `onSelectCommand` 固化 Chip（已实现）
`selectCommandFromKeyboard` 与 `handleCommandSelect` 合并为单一 `selectCommand`：优先处理 `/model` 子菜单与 `model-option`，内置即时命令走即时执行，其余命令调用 `onSelectCommand` 固化 Chip。移除命令选中对 `insertCommandIntoInput` 的裸文本插入。

### 决策 2：`executeCommand` 参数正则改用 `[\s\S]*` 捕获换行（已实现）
使追加文本中的换行内容不被丢弃，完整作为 `args` 发送。

### 决策 3：交互式内置命令复用 Shell PTY 链路执行
当用户在 chat 触发交互式内置命令（首期 `/model`）时，不再调用服务端假实现，而是把该命令送入真实 CLI 进程的 PTY 会话，由 `checkBufferForPrompt` 解析其返回的交互式列表并渲染可选择按钮，选择经 `sendInput` 写回 CLI stdin。

- **为何**：Shell 已完整实现「PTY 跑真实 CLI + 解析提示 + 选项按钮 + 写回 stdin」，复用避免重复造轮子，也保证与终端行为一致。
- **备选**：在 chat 侧新建持久 stdin 通道与提示解析 —— 否决，与既有 Shell 能力重复、维护成本高。

### 决策 4：交互式命令的承载位置 —— 切到 Shell 标签执行（方案 A）
chat 触发交互式内置命令（首期 `/model`）时切到 Shell 标签页，把命令注入该标签页的真实 CLI PTY 会话，用户在 Shell 现有的选项 UI 中选择。

- **为何**：提示解析（`checkBufferForPrompt`）、选项按钮、写回 stdin（`sendInput`）在 Shell 已全部就绪，改动最小。
- **备选**：在 chat 内嵌最小 PTY 会话（方案 B）—— 否决，需抽取共享逻辑并管理 chat 内 PTY 生命周期，成本高。

### 决策 5：`/model` 替换前端硬编码子菜单
输入 `/model` 不再触发 `enterSubmenu('/model')` 的前端硬编码模型列表（即旧的「假实现」本地切换），而是统一走决策 4 的真实 CLI 路径。

- **为何**：用户明确要求 `/model` 吻合 CLI 在终端的真实行为；保留前端假子菜单会造成两套语义混淆。
- **影响**：`useSlashCommands.ts` 中 `/model` 的 `enterSubmenu` 分支、`getModelOptionsForProvider`、`model-option` 选择路径相应调整或移除；`onModelSwitch` 的本地切换行为不再由 `/model` 触发。

## Risks / Trade-offs

- **[风险] 提示解析依赖文本模式**：`checkBufferForPrompt` 依赖 `❯ N.` 与英文页脚（`esc to cancel` / `enter to select`）。不同 CLI / 语言下模式可能不同。→ **缓解**：先针对 `/model` 验证；解析逻辑集中在一处便于扩展。
- **[风险] PTY 会话生命周期**：chat 内若新起 PTY（方案 B），需管理与 chat 会话的绑定、复用与超时清理。→ **缓解**：复用 `ptySessionsMap` 既有的 `projectPath_sessionId` 复用与超时机制。
- **[风险] 抽取共享逻辑引入回归**：方案 B 抽取 `Shell.tsx` 逻辑可能影响现有 Shell。→ **缓解**：抽取时保持 Shell 行为不变，加最小化测试/手动验证。
- **[权衡] 首期仅 `/model`**：范围收敛，验证链路后再推广到其它交互式命令。

## Open Questions

- 触发交互式命令时若当前没有活动 PTY 会话，是自动连接还是提示用户先连接终端？（已实现：自动 `connectToShell()` 后再注入。）
- `/model` 之外哪些内置命令属于「交互式」需纳入后续推广（如 `/config`、`/rewind`）？
- **已知小瑕疵（验证发现）**：注入 `/model\r` 时，`\r` 会被 Claude CLI 的斜杠命令自动补全弹层吞掉（它把回车当作"接受补全"而非"提交"），需用户在终端再按一次 Enter 才展开选择列表。可在注入命令后延迟补发一次回车（如再 `sendInput('\r')`）规避；本次先记录，待按需优化。
