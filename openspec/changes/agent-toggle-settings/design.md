## Context

CloudCLI UI 支持 4 种 AI Agent（Claude、Cursor、Codex、Gemini），目前仅按平台自动过滤（Windows 隐藏 Cursor），缺乏用户主动启停 Agent 的能力。设置面板（`AgentsSettingsTab`）展示所有可用 Agent，模型选择器（`ProviderSelectionEmptyState`）展示所有 Agent 的模型列表。用户无法根据自身需求隐藏不使用的 Agent。

相关代码：
- 设置面板：`src/components/settings/view/tabs/agents-settings/AgentsSettingsTab.tsx`
- 模型选择器：`src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx`
- 模型常量：`shared/modelConstants.js`
- 设置 API：`server/routes/settings.js`
- 数据库 Schema：`server/database/schema.js`（`app_config` 表）

## Goals / Non-Goals

**Goals:**
- 用户可在设置面板中启用或禁用任意 Agent
- 启停状态持久化到服务端数据库
- 新建会话的模型选择器仅展示已启用 Agent 的模型
- 设置面板中未启用的 Agent 有视觉区分但仍可配置

**Non-Goals:**
- 不实现按模型粒度的启停（仅按 Agent 粒度）
- 不涉及已有会话的 Agent 变更（已创建的会话不受影响）
- 不强制至少启用一个 Agent（前端做最低校验即可）
- 不涉及 Agent 的自动检测和推荐

## Decisions

### 1. 存储方案：复用 `app_config` 表

**选择**：使用已有的 `app_config` 表，以 `agent_enabled_<provider>` 为 key，`"true"` / `"false"` 为 value 存储每个 Agent 的启停状态。

**替代方案**：
- 新建 `agent_settings` 表 —— 过度设计，当前只需存储布尔值
- 使用 localStorage 仅前端持久化 —— 不支持多设备同步，与项目整体的服务端持久化模式不一致

**理由**：`app_config` 表已存在且支持任意 key-value 存储，适合简单的配置项。

### 2. API 设计：扩展现有 settings 路由

**选择**：在 `server/routes/settings.js` 中新增两个端点：
- `GET /settings/agent-toggle` — 返回所有 Agent 的启停状态
- `PUT /settings/agent-toggle` — 批量更新启停状态

**理由**：与现有 settings 路由风格一致，批量操作减少请求次数。

### 3. 前端状态传递：自定义 Hook + Context

**选择**：创建 `useAgentToggle` Hook，在设置面板和模型选择器中共享状态。该 Hook 在挂载时从 API 加载状态，更新时调用 API 持久化。

**替代方案**：
- Zustand store —— 项目中 settings 相关状态主要使用 Hook + Props 模式，保持一致
- 直接在各组件中独立加载 —— 会导致重复请求和状态不同步

### 4. 默认值策略

**选择**：所有 Agent 默认为启用状态。数据库中无对应记录时视为启用。

**理由**：向后兼容，现有用户不受影响。

### 5. 最少启用一个 Agent 的校验

**选择**：前端在用户尝试禁用最后一个 Agent 时阻止操作并给出提示，不在后端做强制校验。

**理由**：这是 UX 层面的约束，后端保持简单。

## Risks / Trade-offs

- **[风险] 用户禁用所有 Agent 后无法新建会话** → 前端禁止禁用最后一个已启用的 Agent，按钮置灰并提示
- **[风险] 当前选中的 provider 被禁用** → 模型选择器自动回退到第一个启用的 Agent
- **[权衡] 设置面板中禁用的 Agent 仍可查看但不可编辑** → 保留可查看以降低用户困惑，置灰区分状态
