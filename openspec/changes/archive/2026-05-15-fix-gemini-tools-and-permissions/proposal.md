## Why

Gemini CLI 在 headless 模式（`--prompt` + `--output-format stream-json`）下存在两个严重问题：
1. **Shell 工具不可用**：除 `--yolo` 模式外，`run_shell_command` 等危险工具在 headless 模式下被 Gemini CLI 完全禁用，导致用户看到 `Tool "run_shell_command" not found` 错误。此外，当 UI 传入 Claude 风格的工具名（如 `Shell`）给 `--allowed-tools` 参数时，会进一步限制可用工具。
2. **交互式权限审批无法工作**：当前代码通过 TUI 文本正则检测权限提示，但在 `stream-json` 输出模式下 Gemini CLI 不会产生 TUI 权限提示，导致权限检测代码为死代码（dead code）。

## What Changes

- **移除 `--allowed-tools` 参数传递**：Gemini CLI 的 `--allowed-tools` 已被官方标记为 DEPRECATED，且传入不匹配的工具名会意外限制可用工具。
- **在 headless 模式下始终使用 `--yolo`**：由于 headless + stream-json 模式无法支持交互式审批，需始终使用 `--yolo` 确保所有工具可用。
- **基于 `tool_use` JSON 事件实现应用层权限控制**：通过拦截 Gemini CLI 的 `tool_use` 事件，在 UI 层面实现权限审批流程，替代不可用的 TUI 权限检测。
- **添加 Gemini CLI 工具名与 CloudCLI UI 工具名的映射**：使前端 ToolRenderer 能正确识别和渲染 Gemini CLI 的工具调用（如 `run_shell_command` → `Bash` 显示风格）。

## Capabilities

### New Capabilities
- `gemini-tool-name-mapping`: Gemini CLI 工具名（snake_case）与 CloudCLI UI 工具名（PascalCase）之间的双向映射，用于前端渲染和工具设置传递。
- `gemini-app-level-permissions`: 在应用层实现 Gemini 工具权限控制，基于 `tool_use` JSON 事件判断是否需要用户审批，替代不可用的 TUI 权限检测。

### Modified Capabilities
（无需修改已有 spec 级别的行为定义）

## Impact

- **后端**：`server/gemini-cli.js` — 修改 CLI 参数构建逻辑、移除 `--allowed-tools` 传递、始终传入 `--yolo`
- **后端**：`server/gemini-response-handler.js` — 增加 `tool_use` 事件拦截逻辑，支持应用层权限控制
- **前端**：`src/components/chat/tools/configs/toolConfigs.ts` — 添加 Gemini 工具名别名映射
- **前端**：`src/components/chat/hooks/useChatRealtimeHandlers.ts` — 处理 Gemini 权限流程的新消息类型
- **共享**：新增工具名映射常量文件（或在 `shared/` 中添加）
