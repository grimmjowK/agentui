## 1. 状态管理 —— 待发命令 Chip

- [x] 1.1 在 `useChatComposerState` 中新增 `pendingCommand: SlashCommand | null` 及 `setPendingCommand` 状态
- [x] 1.2 将 `pendingCommand` 和 `clearPendingCommand` 从 hook 返回值中导出

## 2. 命令选中 → 显示 Chip（不立即执行）

- [x] 2.1 修改 `useSlashCommands.selectCommandFromKeyboard`：新增 `onSelectCommand` 回调，不直接调用 `onExecuteCommand`，由父组件决定后续行为
- [x] 2.2 修改 `useSlashCommands.handleCommandSelect`：对非 builtin 命令同样调用 `onSelectCommand` 而非 `onExecuteCommand`
- [x] 2.3 在 `useChatComposerState` 中将 `onSelectCommand` 绑定为：设置 `pendingCommand` 并清空 textarea

## 3. 提交时携带 Chip 命令执行

- [x] 3.1 在 `handleSubmit` 中，优先检查 `pendingCommand` 是否有值（置于现有 `/` 拦截逻辑之前）
- [x] 3.2 若 `pendingCommand` 有值，则调用 `executeCommand(pendingCommand, currentInput.trim())`，执行后清空 Chip 和输入框
- [x] 3.3 在提交时将 textarea 内容（`appendedText`）存入局部变量，供消息展示使用（见第 5 步）

## 4. Chip 删除 —— × 按钮 与 Backspace

- [x] 4.1 在 `handleKeyDown`（或 `ChatComposer` 的键盘事件处理）中：当 `pendingCommand` 有值且 textarea 为空时，检测 Backspace → 调用 `clearPendingCommand`
- [x] 4.2 将 `pendingCommand` 和 `clearPendingCommand` 作为 props 传入 `ChatComposer`

## 5. 用户消息展示 —— 只显示追加文本

- [x] 5.1 在 `handleCustomCommand` 中新增可选参数 `displayText: string`
- [x] 5.2 构建 `userMessage` 对象时，将 `content` 设为 `displayText`（若有），否则回退为 `/<commandName>`
- [x] 5.3 打通调用链：`handleSubmit` → `executeCommand` → `handleCustomCommand`，传递追加文本

## 6. UI —— CommandChip 组件

- [x] 6.1 新建 `CommandChip` 组件：`src/components/chat/view/subcomponents/CommandChip.tsx`，渲染命令名标签与 `×` 删除按钮
- [x] 6.2 在 `ChatComposer` 的 textarea 上方，当 `pendingCommand` 有值时渲染 `CommandChip`
- [x] 6.3 样式与现有 Composer 设计保持一致（圆角标签、柔和配色、小字号）

## 7. 兜底与边界情况

- [x] 7.1 当用户在已有 Chip 的情况下再次选中命令时，替换旧 Chip 并清空 textarea
- [x] 7.2 确保 builtin 命令（type 为 `"builtin"`）依然即时执行，不显示 Chip
- [x] 7.3 验证点击 `×` 或按 Backspace 删除 Chip 后，焦点正确回到 textarea
