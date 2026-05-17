## ADDED Requirements

### Requirement: Agent 启停状态持久化
系统 SHALL 将每个 Agent（claude、cursor、codex、gemini）的启停状态持久化到服务端数据库，使用 `app_config` 表，key 格式为 `agent_enabled_<provider>`，value 为 `"true"` 或 `"false"`。当数据库中无对应记录时，系统 SHALL 视该 Agent 为启用状态。

#### Scenario: 首次使用时所有 Agent 默认启用
- **WHEN** 用户首次访问系统，数据库中无任何 `agent_enabled_*` 记录
- **THEN** 所有 4 个 Agent（claude、cursor、codex、gemini）SHALL 被视为启用状态

#### Scenario: 禁用后重新加载保持状态
- **WHEN** 用户禁用了 Codex Agent 并刷新页面
- **THEN** Codex 的状态 SHALL 仍为禁用

### Requirement: Agent 启停 API 接口
系统 SHALL 提供 REST API 接口供前端读写 Agent 启停配置。

#### Scenario: 获取所有 Agent 的启停状态
- **WHEN** 前端发送 `GET /settings/agent-toggle` 请求
- **THEN** 系统 SHALL 返回 JSON 对象，包含所有 Agent 的启停状态，格式为 `{ "claude": true, "cursor": true, "codex": true, "gemini": true }`

#### Scenario: 批量更新 Agent 启停状态
- **WHEN** 前端发送 `PUT /settings/agent-toggle` 请求，body 为 `{ "codex": false, "gemini": false }`
- **THEN** 系统 SHALL 更新指定 Agent 的启停状态并返回更新后的完整状态

#### Scenario: 无效的 provider 名称
- **WHEN** 前端发送包含无效 provider 名称的请求（如 `{ "invalid_agent": false }`）
- **THEN** 系统 SHALL 忽略无效的 provider 名称，仅处理合法的 provider

### Requirement: 设置面板中的 Agent 启停开关
设置面板的 Agent 列表中，每个 Agent 条目 SHALL 包含一个启用/禁用开关控件。

#### Scenario: 用户禁用一个 Agent
- **WHEN** 用户在设置面板中关闭某个 Agent 的开关
- **THEN** 该 Agent 的状态 SHALL 立即更新为禁用，并持久化到服务端

#### Scenario: 禁止禁用最后一个 Agent
- **WHEN** 仅剩一个 Agent 处于启用状态，用户尝试禁用该 Agent
- **THEN** 系统 SHALL 阻止操作并展示提示信息，告知至少需要保留一个启用的 Agent

#### Scenario: 已禁用 Agent 的视觉区分
- **WHEN** 某个 Agent 被禁用
- **THEN** 该 Agent 在列表中 SHALL 以灰显样式展示，且其配置区域（账户、权限）SHALL 不可编辑

### Requirement: 模型选择器过滤未启用的 Agent
新建会话时的模型选择器 SHALL 仅展示已启用 Agent 的模型分组。

#### Scenario: 禁用 Agent 的模型不出现在选择器中
- **WHEN** 用户禁用了 Cursor 和 Codex
- **THEN** 模型选择器 SHALL 仅展示 Claude 和 Gemini 的模型分组

#### Scenario: 当前选中的 provider 被禁用后自动回退
- **WHEN** 用户当前选中的 provider 是 Codex，且 Codex 被禁用
- **THEN** 系统 SHALL 自动将选中的 provider 切换到第一个启用的 Agent，并更新 localStorage

#### Scenario: 结合平台过滤
- **WHEN** 系统运行在 Windows 平台（Cursor 不可用），且用户额外禁用了 Gemini
- **THEN** 模型选择器 SHALL 仅展示 Claude 和 Codex 的模型分组（平台过滤与用户配置叠加）
