## ADDED Requirements

### Requirement: Headless 模式始终使用 yolo
系统 SHALL 在以 headless 模式（`--prompt`）启动 Gemini CLI 时始终传入 `--yolo` 参数，确保所有工具（包括 `run_shell_command`、`write_file`、`replace`）均可用。

#### Scenario: auto_edit 权限模式下 shell 工具可用
- **WHEN** 用户在 UI 中选择 `auto_edit` 权限模式并发送包含 shell 命令请求的消息
- **THEN** Gemini CLI SHALL 以 `--yolo` 启动，且 `run_shell_command` 工具 SHALL 正常执行并返回结果

#### Scenario: plan 权限模式下所有工具可用
- **WHEN** 用户在 UI 中选择 `plan` 权限模式并发送消息
- **THEN** Gemini CLI SHALL 以 `--yolo` 启动，所有工具 SHALL 可用

### Requirement: 移除 allowed-tools 参数传递
系统 SHALL NOT 将 UI 的 `toolsSettings.allowedTools` 列表传递给 Gemini CLI 的 `--allowed-tools` 参数。

#### Scenario: 有 allowedTools 设置时不传递给 Gemini CLI
- **WHEN** 用户在 UI 设置中配置了 `allowedTools` 列表（如 `["Shell", "Edit"]`）且使用 Gemini 模型
- **THEN** 后端构建 Gemini CLI 命令时 SHALL NOT 包含 `--allowed-tools` 参数

### Requirement: 移除 TUI 权限检测代码
`GeminiPermissionDetector` 类 SHALL 被标记为 deprecated 并在构建 CLI 参数时不再依赖其检测结果。权限提示的发送逻辑可以保留但标注为废弃。

#### Scenario: stream-json 模式下不触发权限检测
- **WHEN** Gemini CLI 以 `--yolo` + `--output-format stream-json` 运行
- **THEN** 系统 SHALL NOT 发送 `permission_request` 类型的 WebSocket 消息（因为 yolo 模式下不会有权限提示）

### Requirement: UI 权限模式说明
当 provider 为 Gemini 时，UI 的权限模式选择器 SHALL 显示提示信息，说明 Gemini CLI 在 headless 模式下工具会自动执行，权限模式设置仅影响显示行为而非实际执行行为。

#### Scenario: 显示 Gemini 权限模式提示
- **WHEN** 用户在设置中切换到 Gemini provider 并查看权限模式选项
- **THEN** UI SHALL 显示提示文本说明 Gemini 模式的权限行为差异
