## 1. 修复 Chip 固化回归（useSlashCommands）

- [x] 1.1 在 `selectCommandFromKeyboard` 中，对需固化的命令（非 `builtin`、非 `model-option`、非 `/model` 入口）改为调用 `onSelectCommand(command)` 而非 `insertCommandIntoInput`
- [x] 1.2 在 `handleCommandSelect` 的点击路径中做相同改造，保持点击 / Enter / Tab 三种方式一致固化 Chip
- [x] 1.3 保留 `/model`（`enterSubmenu`）与 `model-option`（`onModelSwitch`）分支优先于 Chip 固化判断，避免误吞
- [x] 1.4 确认 `builtin` 命令仍走 `executeNonSkillCommand` 即时执行、不固化 Chip
- [x] 1.5 清理或收敛不再用于命令选中的 `insertCommandIntoInput` 裸文本插入路径

## 2. 修复追加文本随命令发送（useChatComposerState）

- [x] 2.1 确认 `handleSelectCommand` 在收到 `onSelectCommand` 后正确 `setPendingCommand` 并清空输入
- [x] 2.2 验证 `handleSubmit` 的 pending 分支用 `命令名 + 追加文本` 组装 `rawInput`，且换行追加内容不丢失
- [x] 2.3 验证 `executeCommand` 的 `args` 正则能从 `rawInput` 正确切出追加文本作为参数（修复 dotAll 缺失导致换行后内容被丢弃）
- [x] 2.4 确认 `displayTextOverrideRef` 使消息气泡只展示追加文本（无追加文本时回退命令名）

## 3. 交互式内置命令路由到 Shell PTY（承载方案 A：切到 Shell 标签）

- [x] 3.1 在 chat 侧识别「交互式内置命令」（首期 `/model`），选中/发送时不走 `/api/commands/execute` 假实现，改为触发切到 Shell 标签
- [x] 3.2 提供从 chat 到 Shell 的「待注入命令」传递机制（`AppContent` 的 `runInShell` + `setActiveTab` → `MainContent` → `StandaloneShell` → `Shell` 传入 `pendingCommand`）
- [x] 3.3 `Shell` 在 PTY 会话就绪后将待注入命令通过 `type: 'input'` 写入真实 CLI（分两步：先写 `/model` 文本，延迟后补发 `\r` 提交，避免回车被 CLI 自动补全弹层吞掉），以 nonce 去重仅注入一次

## 4. 复用 Shell 的提示解析与选择回传（验证 + 必要适配）

- [x] 4.1 复用 `checkBufferForPrompt` 解析注入 `/model` 后真实 CLI 返回的交互式选择列表（沿用既有实现，无需改动）
- [x] 4.2 复用选项按钮 `sendInput(opt.number)` 写回 CLI stdin、Esc 经 `\x1b` 取消（沿用既有实现）
- [x] 4.3 验证确认 `checkBufferForPrompt` 能正确解析 Claude CLI 的 `/model` 列表（`❯ N. label` + 页脚），无需改解析逻辑。注入回车被自动补全弹层吞掉的小瑕疵已在 3.3 修复（命令文本与回车分两步发送）
- [x] 4.4 处理触发时无活动 PTY 会话的情况：`Shell` 注入前若未连接则先 `connectToShell()`，连接就绪后再注入

## 5. 验证

- [x] 5.1 `npm run typecheck`：**完全通过**（同时修复了预先存在于 HEAD 的 `isTemporarySessionId` 未定义错误：该 helper 全仓库从未定义，`effectiveSessionId` 均为真实 id，改为与上方对称的 `if (effectiveSessionId)` 真值判断）
- [x] 5.2 `npm run lint`：0 errors；本次改动文件无新增 unused/exhaustive-deps 告警（其余为仓库既有 import-order 告警）
- [x] 5.3 浏览器验证通过：`/opsx:apply` 回车固化为可删除 Chip（含 × 与「移除命令」按钮）；换行追加文本随命令发送 —— 拦截 `/api/commands/execute` 实测 `args: ["第一行参数","第二行参数"]`，**换行后内容完整送达**（dotAll 修复生效）
- [x] 5.4 浏览器验证通过：chat 输入 `/model` 自动切到 Shell 标签并注入真实 CLI；CLI 返回的「Select model」列表被 `checkBufferForPrompt` 解析为底部可点击选项按钮（1-5 + Esc）；点击「2. claude-opus-4-7」写回 stdin，CLI 回显「Set model to Opus 4.7」，**端到端生效**
