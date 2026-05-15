## ADDED Requirements

### Requirement: Gemini 工具名到 CloudCLI UI 工具名的映射
系统 SHALL 维护一份 Gemini CLI 工具名（snake_case）到 CloudCLI UI 工具名（PascalCase）的映射表，用于前端工具渲染时选择正确的显示配置。

映射关系：
| Gemini CLI 工具名 | CloudCLI UI 显示配置 |
|---|---|
| `run_shell_command` | `Bash` |
| `read_file` | `Read` |
| `write_file` | `Write` |
| `replace` | `Edit` |
| `grep_search` | `Grep` |
| `glob` | `Glob` |
| `web_fetch` | `WebFetch` (Default) |
| `google_web_search` | `WebSearch` (Default) |
| `write_todos` | `TodoWrite` |
| `enter_plan_mode` | `ExitPlanMode` |
| `invoke_agent` | `Task` |
| `list_directory` | `ListDirectory` (Default) |
| `list_background_processes` | Default |
| `read_background_output` | Default |
| `update_topic` | Default (hidden) |
| `activate_skill` | Default |

#### Scenario: 渲染 run_shell_command 工具调用
- **WHEN** 前端收到 Gemini 的 `tool_use` 事件且 `toolName` 为 `run_shell_command`
- **THEN** ToolRenderer SHALL 使用 `Bash` 的显示配置渲染该工具调用（终端风格图标、绿色边框、command 字段显示）

#### Scenario: 渲染 replace 工具调用
- **WHEN** 前端收到 Gemini 的 `tool_use` 事件且 `toolName` 为 `replace`
- **THEN** ToolRenderer SHALL 使用 `Edit` 的显示配置渲染该工具调用（diff 视图）

#### Scenario: 渲染未知 Gemini 工具
- **WHEN** 前端收到 Gemini 的 `tool_use` 事件且 `toolName` 不在映射表中
- **THEN** ToolRenderer SHALL 使用 `Default` 配置渲染该工具调用（可折叠的 JSON 参数视图）

### Requirement: 工具参数字段适配
系统 SHALL 在映射工具名的同时适配参数字段名差异，确保 getValue/getContentProps 等函数能正确提取 Gemini 工具的参数。

| Gemini 工具 | Gemini 参数 | 对应 CloudCLI 参数 |
|---|---|---|
| `run_shell_command` | `command` | `command`（一致） |
| `read_file` | `file_path` | `file_path`（一致） |
| `write_file` | `file_path`, `content` | `file_path`, `content`（一致） |
| `replace` | `file_path`, `old_string`, `new_string` | `file_path`, `old_string`, `new_string`（一致） |
| `grep_search` | `pattern`, `path` | `pattern`, `path`（一致） |

#### Scenario: run_shell_command 参数提取
- **WHEN** ToolRenderer 渲染 `run_shell_command` 工具且输入参数为 `{ "command": "echo hello" }`
- **THEN** 显示的命令值 SHALL 为 `echo hello`
