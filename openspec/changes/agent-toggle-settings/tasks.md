## 1. 后端 API 与数据持久化

- [x] 1.1 在 `server/routes/settings.js` 中新增 `GET /settings/agent-toggle` 端点，从 `app_config` 表读取所有 `agent_enabled_*` 键，返回各 Agent 的启停状态 JSON（无记录视为启用）
- [x] 1.2 在 `server/routes/settings.js` 中新增 `PUT /settings/agent-toggle` 端点，接收 `{ [provider]: boolean }` 格式的 body，使用 upsert 写入 `app_config` 表，忽略无效 provider 名称
- [x] 1.3 验证 API 端点：首次请求返回全部为 true；更新后重新获取返回正确状态

## 2. 前端状态管理

- [x] 2.1 创建 `src/hooks/useAgentToggle.ts` Hook，封装 Agent 启停状态的加载（`GET`）和更新（`PUT`）逻辑，提供 `enabledAgents` 状态和 `toggleAgent` 方法
- [x] 2.2 在 Hook 中实现"禁止禁用最后一个 Agent"的前端校验逻辑

## 3. 设置面板 UI

- [x] 3.1 在 `AgentSelectorSection` 或 `AgentListItem` 组件中为每个 Agent 添加启用/禁用开关（Switch 控件），调用 `useAgentToggle` 的 `toggleAgent` 方法
- [x] 3.2 当仅剩一个 Agent 启用时，该 Agent 的开关置灰并展示 tooltip 提示
- [x] 3.3 未启用的 Agent 在列表中以灰显样式展示，其配置区域（账户、权限标签内容）展示为不可编辑状态

## 4. 模型选择器过滤

- [x] 4.1 在 `ProviderSelectionEmptyState` 组件中引入 `useAgentToggle` Hook，将 `visibleProviderGroups` 的过滤逻辑扩展为同时考虑平台过滤和 Agent 启停状态
- [x] 4.2 当用户当前选中的 provider 被禁用时，自动回退到第一个启用的 Agent 并更新 localStorage
- [x] 4.3 在 `useChatProviderState` Hook 中处理初始化时 localStorage 中存储的 provider 已被禁用的情况

## 5. 国际化

- [x] 5.1 在 `src/i18n/locales/` 的中英文翻译文件中添加 Agent 启停相关的文案（开关标签、最少一个 Agent 提示、禁用态说明等）

## 6. 验证与测试

- [x] 6.1 启动开发服务器，在设置面板中验证开关的启停操作和持久化
- [x] 6.2 验证禁用 Agent 后，新建会话的模型选择器不展示该 Agent 的模型
- [x] 6.3 验证禁用当前选中的 provider 后自动回退到第一个启用的 Agent
- [x] 6.4 验证最后一个 Agent 无法被禁用
- [x] 6.5 运行 `npm run typecheck` 和 `npm run lint` 确保无报错
