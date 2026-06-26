## 1. 撤销 /model → Shell 路由

- [x] 1.1 `useSlashCommands.selectCommand`：移除 `/model` 的 `onRunInShell('/model')` 分支（`selectCommand` 现统一固化 Chip）
- [x] 1.2 `useSlashCommands.handleCommandInputChange`：移除精确匹配 `/model` 时的 `onRunInShell` 路由
- [x] 1.3 核查 build-in 指令场景不再调用 `onRunInShell`（已移除 hook 内 `onRunInShell` 使用）；Shell 标签自身的 PTY 注入链路（`pendingCommand`）保留但不被 build-in 使用

## 2. build-in 指令固化为 Chip

- [x] 2.1 让 build-in 指令在 `selectCommand` 中走 `onSelectCommand(command)` 固化 Chip（点击 / Enter / Tab 一致；现所有菜单命令统一固化，移除了 `executeNonSkillCommand`/`isSkillCommand` 死代码）
- [x] 2.2 确认 build-in Chip 提交后经 `handleSubmit` pending 分支 → `executeCommand` → `handleBuiltInCommand` 正常执行（链路已存在，未改动）
- [x] 2.3 即时类 build-in（`/clear`、`/config`）统一固化 Chip，回车提交后由 `handleBuiltInCommand` 触发对应 action（保持统一交互）

## 3. /model 内联可选择列表

- [x] 3.1 改造 `handleBuiltInCommand` 的 `model` 分支：无模型参数时 `addMessage` 结构化消息（`isBuiltinModelList` + `modelOptions`(来自 modelConstants) + `currentModel`），不再拼纯文本
- [x] 3.2 在 `MessageComponent` 中渲染为可点击模型列表，当前模型高亮（✓）
- [x] 3.3 点击模型项调用 `onModelSwitch(value)`（=composer 的 `handleModelSwitch`）切换；列表 `currentModel` 高亮反映选中
- [x] 3.4 带模型名参数的 `/model` 仍走 `handleModelSwitch` 直接切换（`data.message` 以 "Switching to model:" 开头分支，未改动）
- [x] 3.5 修复 `e.map is not a function` 崩溃：模型列表消息此前未被 session store 的 normalize 往返保留（落到通用 `text` kind、字段丢失/错型）。新增客户端专用 `builtin_model_list` kind，在 `chatMessageToNormalized`（序列化）与 `normalizedToChatMessages`（反序列化）双向处理，并对 `modelOptions` 做 `Array.isArray` 守卫（store 类型 + 渲染处）

## 4. 验证

- [x] 4.1 `npm run typecheck` 通过（完全干净）
- [x] 4.2 `npm run lint` 通过（0 errors，改动文件无新增告警）
- [x] 4.3 浏览器验证通过：选中 `/model`、`/cost` 等 build-in 指令均固化为可删除 Chip（"移除命令" 按钮），不切标签页
- [x] 4.4 浏览器验证通过：提交 `/model` 在 chat 内联渲染可点击模型列表（7 项含 label+value，当前模型 ✓ 高亮）；点击 Sonnet → `claude-model` 切为 sonnet + "Model switched to: sonnet" 消息；重开 `/model` 列表 ✓ 正确移到 Sonnet；全程留在 chat
- [x] 4.5 浏览器验证通过：`/cost` 结果（Token Usage / Estimated Cost / Model）在 chat 内联展示，无标签页切换
