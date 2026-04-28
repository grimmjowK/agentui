## 背景

Web 端当前的斜杠命令在用户从下拉菜单选中后会立即执行 —— 命令展开的 Markdown Prompt 被填入输入框并直接提交。这导致两个问题：

1. **无法追加参数**：很多斜杠命令本质是模板，需要用户补充上下文，但目前没有这个步骤。
2. **对话记录噪音大**：完整的 Prompt Markdown（可能数百行）被存入并展示为「用户消息」，掩盖了用户的真实意图。

涉及文件：
- `src/components/chat/hooks/useSlashCommands.ts` —— 命令选择与键盘处理
- `src/components/chat/hooks/useChatComposerState.ts` —— `executeCommand`、`handleCustomCommand`、`handleSubmit`
- `src/components/chat/view/subcomponents/ChatComposer.tsx` —— 输入框 UI
- `src/components/chat/view/subcomponents/CommandMenu.tsx` —— 下拉菜单

## 目标 / 非目标

**目标：**
- 选中斜杠命令后，在输入框内渲染为可删除的内联 Chip，不立即发送
- 允许用户在 Chip 后继续输入自由文本
- 支持通过 `×` 按钮点击或 Backspace（光标在位置 0 且输入框为空时）删除 Chip
- 发送后，对话气泡只展示追加文本（无追加文本则回退为命令名）
- 完整 Prompt 依然传给模型，只改变展示层

**非目标：**
- 不改变内置命令（如 `/clear`、`/settings`）的行为
- 不支持多个 Chip 同时存在
- 不修改与服务端的 API 协议

## 技术决策

### 决策 1：Chip 状态存放在 `useChatComposerState`（而非 `useSlashCommands`）

**决定**：在 `useChatComposerState` 中新增 `pendingCommand: SlashCommand | null` 状态。选中命令时设置该状态，不立即调用 `executeCommand`；在用户提交时，将输入框中的文字作为 `rawInput` 传入 `executeCommand`。

**原因**：该 hook 已经持有 `input`、`handleSubmit`、`executeCommand`，状态集中管理，避免跨组件传递额外 props。

**备选方案**：将状态放在 `useSlashCommands` 中 —— 已否决，因为该 hook 无法直接访问 `handleSubmit`。

---

### 决策 2：Chip 在 `ChatComposer` 的 textarea 上方渲染

**决定**：当 `pendingCommand` 有值时，在 textarea 上方渲染一个小标签元素（包含命令名和 `×` 按钮）。textarea 保持焦点，供追加文本输入。

**原因**：`<textarea>` 无法内嵌自定义 DOM 节点。将 Chip 显示在 textarea 上方是成熟的设计模式（类似邮件「收件人」字段），无需修改 textarea 本身。

**备选方案**：将 textarea 改为 `contenteditable` div 以支持真正的内联 Chip —— 已否决，改写量过大，且 accessibility 和粘贴处理复杂度高。

---

### 决策 3：用户消息气泡只显示追加文本，回退为命令名

**决定**：在 `handleCustomCommand` 中保存用户输入的 `rawInput`（即 Chip 后 textarea 中的文本）。提交时将 `userMessage.content` 设为该追加文本（trim 后）。若为空，则回退为 `/<commandName>`。

**原因**：完整 Prompt 可能有数千字符，污染对话记录。用户只需看到自己写了什么，模型仍接收完整 Prompt。

## 风险 / 权衡

- **[风险] 粘贴命令触发**：用户粘贴以 `/commandName` 开头的文本，`handleSubmit` 中的拦截逻辑仍会生效。→ **缓解措施**：Chip UX 只在从下拉菜单选中时触发；粘贴/直接输入路径保持原有行为不变。
- **[风险] 内置命令冲突**：内置命令（如 `/clear`）返回 `type: "builtin"`，不应显示 Chip。→ **缓解措施**：仅对非 builtin 类型命令设置 `pendingCommand`，builtin 命令走原有即时执行路径。
- **[权衡] 单 Chip 限制**：设计只支持同时存在一个 Chip。选中新命令会替换旧 Chip。符合直觉，保持状态简单。
