## Why

用户可能只使用部分 AI Agent（如仅用 Claude 和 Gemini，不用 Cursor 和 Codex）。目前系统仅基于平台过滤（Windows 隐藏 Cursor），没有手动启停 Agent 的配置。未启用的 Agent 仍会出现在模型选择器中，增加了不必要的干扰，也可能导致误选未配置的 Agent。

## What Changes

- 在设置面板的 Agents 标签页中，为每个 Agent 添加启用/禁用开关
- Agent 的启停状态持久化到数据库（`app_config` 表），并通过 API 提供读写接口
- 新建会话时，模型选择器仅展示已启用 Agent 的模型分组
- 设置面板的 Agent 列表中，未启用的 Agent 以视觉化方式区分（如灰显）
- 默认所有 Agent 为启用状态，保持向后兼容

## Capabilities

### New Capabilities
- `agent-toggle`: Agent 启停配置功能，涵盖设置 UI 的开关控件、状态持久化 API、以及模型选择器的过滤逻辑

### Modified Capabilities

（无需修改已有 spec 级别的能力定义）

## Impact

- **前端**: `AgentsSettingsTab`、`AgentSelectorSection` 需增加开关组件；`ProviderSelectionEmptyState` 需根据启停状态过滤 `PROVIDER_GROUPS`
- **后端**: `settings.js` 路由需增加 Agent 启停配置的读写 API 端点
- **数据库**: 使用已有的 `app_config` 表存储启停状态，无需新增表
- **共享状态**: 需新增自定义 Hook 或扩展现有 Context 来传递 Agent 启停状态
- **兼容性**: 纯增量变更，不涉及破坏性改动
