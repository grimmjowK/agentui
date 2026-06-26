# server/modules — 业务模块索引

后端模块化业务核心。每个模块内部按 `services/`（业务逻辑）、`tests/`（测试）、
`repositories/`（数据访问）等分层。

## 模块清单

### `database/` — 持久化层（含 `repositories/`）
管理 SQLite 连接单例、初始化和迁移。通过 repositories 类暴露用户、会话、项目、
凭证等多张数据表的 CRUD 接口。

### `projects/` — 项目生命周期管理（含 `services/`、`tests/`）
处理项目创建、克隆、删除、星标、显示名称生成、TaskMaster 检测与会话关联。
`services/` 负责业务逻辑，`tests/` 覆盖关键流程。

### `providers/` — LLM 多源适配中枢（含 `list/`、`shared/`、`services/`、`tests/`）
统一适配 Claude / Cursor / Codex / Gemini 多个提供商。
- 通过 `AbstractProvider` 基类和 `IProvider` 接口规范统一行为。
- `list/` 下每个目录代表一个提供商实现（含 `auth`/`mcp`/`sessions`/`skills` 等能力）。
- `shared/` 存放基类及 MCP / Skills 共享实现。
- 与根目录 `claude-sdk.js`、`gemini-cli.js`、`cursor-cli.js`、`openai-codex.js` 等
  CLI/SDK 集成层协作。

### `websocket/` — 实时通信网关（含 `services/`）
创建单一 WebSocketServer，管理三条路由：`/ws`（聊天）、`/shell`（命令行）、
`/plugin-ws`（插件代理）。`services/` 分别处理各路由及认证状态管理。
