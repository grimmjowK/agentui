## Context

CloudCLI UI 通过子进程（PTY）方式与 Gemini CLI 通信，使用 `--prompt`（headless）+ `--output-format stream-json` 模式。每次用户发送消息时启动一个新的 Gemini CLI 进程，通过 `--resume` 恢复会话上下文。

当前存在两个核心问题：

1. **Gemini CLI 在 headless 模式下禁用危险工具**：经测试验证，除 `--yolo` 外，`--approval-mode auto_edit`、`--approval-mode default` 甚至 `--approval-mode plan` 在 headless 模式下都会导致 `run_shell_command`、`write_file`、`replace` 等工具不可注册。Gemini CLI 的设计逻辑是：headless 模式无法交互式确认，因此禁用需要确认的工具。

2. **`--allowed-tools` 参数已被 Gemini CLI 官方废弃**（v0.42.0），且该参数会将工具列表**限制**为仅允许列表中的工具。当 UI 传入 Claude 风格工具名（如 `Shell`、`Edit`）时，这些名称不匹配 Gemini CLI 的工具名（如 `run_shell_command`、`replace`），导致几乎所有工具被意外禁用。

3. **TUI 权限检测在 stream-json 模式下失效**：`GeminiPermissionDetector` 依赖正则匹配 TUI 格式的权限提示文本，但 `--output-format stream-json` 模式下 Gemini CLI 不输出 TUI 文本，导致权限检测代码为死代码。

## Goals / Non-Goals

**Goals:**
- 确保 Gemini CLI 的所有工具（包括 `run_shell_command`）在各种权限模式下均可用
- 前端能正确识别和渲染 Gemini CLI 的工具调用（`run_shell_command` → 终端风格显示）
- 移除已废弃的 `--allowed-tools` 参数传递
- 清理不可用的 TUI 权限检测代码，替换为可工作的权限机制

**Non-Goals:**
- 不实现 Gemini CLI 交互模式（`--prompt-interactive`）的完整支持 — 这需要重构会话管理架构，是后续独立变更
- 不实现工具级别的细粒度权限控制（如"仅允许读文件但不允许写"）
- 不修改 Gemini CLI 本身的行为

## Decisions

### Decision 1: Headless 模式始终使用 `--yolo`

**选择**：在 headless（`--prompt`）模式下，始终向 Gemini CLI 传入 `--yolo` 参数。

**替代方案**：
- A) 切换到 `--prompt-interactive` 模式以获得原生权限支持 → 需要重构整个会话管理架构（保持进程存活、多轮消息写入 stdin、会话生命周期管理），复杂度过高
- B) 使用非 stream-json 输出格式以获取 TUI 权限提示 → 失去结构化 JSON 事件，需要完全重写解析器

**理由**：headless + stream-json 是当前架构的基础。`--yolo` 是唯一能让所有工具在 headless 模式下可用的方式。权限控制在应用层实现。

### Decision 2: 应用层权限控制基于 `tool_use` 事件的后置通知

**选择**：由于 `--yolo` 模式下工具自动执行，无法在执行前拦截。改为在 `tool_use` 和 `tool_result` 事件后向用户展示工具执行结果，并在 UI 的权限模式设置中提供明确提示：Gemini 模式下工具会自动执行。

**理由**：headless + yolo 模式下，工具调用和结果是同步的。Gemini CLI 内部已经有安全保护（如沙箱模式 `--sandbox`），应用层不需要重复实现阻塞式权限。

### Decision 3: 工具名映射在前端 ToolRenderer 层实现

**选择**：在 `toolConfigs.ts` 中为 Gemini CLI 工具名添加别名映射，使 `run_shell_command` 复用 `Bash` 的渲染配置。

**替代方案**：
- A) 在后端标准化时将工具名转换为 Claude 风格 → 会丢失原始工具名信息，且增加后端复杂度
- B) 在 ToolRenderer 中添加前置名称转换函数 → 侵入性更强

**理由**：`getToolConfig()` 已有 fallback 到 `Default` 的机制，只需添加别名条目即可。保持后端原始数据不变，前端按需映射。

### Decision 4: 移除 `--allowed-tools` 参数传递，保留 UI 设置但不传给 Gemini CLI

**选择**：不再将 `toolsSettings.allowedTools` 传递给 Gemini CLI 的 `--allowed-tools` 参数。

**理由**：该参数已被 Gemini CLI 官方废弃（将在 1.0 移除），且其行为（限制可用工具）与 UI 的预期（免确认工具列表）不一致。

## Risks / Trade-offs

- **[安全]** `--yolo` 模式下所有工具自动执行，用户无法在执行前阻止危险操作 → **缓解**：UI 中 Gemini 权限模式选择处添加明确提示说明此行为；用户可选择 Gemini CLI 的 `--sandbox` 模式进行隔离
- **[用户体验]** 权限模式设置（auto_edit / plan）对 Gemini 不生效 → **缓解**：在 UI 中明确标注 Gemini 模式的行为差异
- **[向前兼容]** 未来 Gemini CLI 可能在 stream-json 模式下支持结构化权限事件 → **缓解**：保留 `GeminiPermissionDetector` 代码但标记为 deprecated，便于后续替换
