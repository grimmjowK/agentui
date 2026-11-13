# server/modules — 业务模块索引

后端模块化业务核心。每个模块内部按 `services/`（业务逻辑）、`tests/`（测试）、
`repositories/`（数据访问）等分层。

## 模块清单

### `database/` — 持久化层（含 `repositories/`）
管理 SQLite 连接单例、初始化和迁移。通过 repositories 类暴露用户、会话、项目、
凭证等多张数据表的 CRUD 接口。

`session_messages` 是聊天内容的持久化事实来源。`session-message-log` 的
`LoggingWriter` 在送出持久性聊天事件前写入该表并附加会话内 `seq`；provider
历史档只在读取时用于補齐或导入旧会话，不再直接决定前端顺序。

### `projects/` — 项目生命周期管理（含 `services/`、`tests/`）
处理项目创建、克隆、删除、星标、显示名称生成、TaskMaster 检测与会话关联。
`services/` 负责业务逻辑，`tests/` 覆盖关键流程。

### `providers/` — LLM 多源适配中枢（含 `list/`、`shared/`、`services/`、`tests/`）
统一适配 Claude / Cursor / Codex / Antigravity。provider 清单与能力（插话、图片、推理强度、产物）
以 `shared/providers.ts` 的 `PROVIDER_IDS` / `PROVIDER_INFO` 为准，前后端共用。
- 通过 `AbstractProvider` 基类和 `IProvider` 接口规范统一行为，facet 包括
  `auth`/`mcp`/`skills`/`sessions`/`sessionSynchronizer`/`runtime`，详见 [providers/README.md](./providers/README.md)。
- `list/<id>/<id>-runtime.provider.ts` 包装根目录执行层（`claude-sdk.js`、`cursor-cli.js`、
  `openai-codex.ts`、`antigravity-cli.js`）。
- `list/codex/codex-item-mapper.ts`、`list/antigravity/antigravity-tool-mapper.ts` 把各家事件映射为
  Claude 工具形状，前端对话流不按 provider 分支。
- `services/session-conversations-search.service.ts`：全文检索，提取交给各 facet 的
  `extractSearchableMessages`；`session-synchronizer.service.ts`：各 provider 独立的扫描游标。
- `services/session-references.service.ts`：聊天框 `@session:<id>` 跨 provider 引用。送出时把被引用会话导出到
  `<cwd>/.tmp/session-refs/<id>.md`，prompt 末尾只附引用清单与路径，由 agent 自行读取；日志里存用户原文。

### `codex-runtime/` — Codex app-server 连接
`CodexAppServer`（JSON-RPC over stdio）、审批池 `codexApprovals`、线程占用锁 `codexOwnership`。
`protocol/` 是 `npm run codex:gen-types` 生成的协议型别（只保留用到的方法），勿手改。

### `websocket/` — 实时通信网关（含 `services/`）
创建单一 WebSocketServer，管理三条路由：`/ws`（聊天）、`/shell`（命令行）、
`/plugin-ws`（插件代理）。`services/` 分别处理各路由及认证状态管理。
聊天路由的消息：`chat-command`（启动/续接）、`chat-steer`（执行中插话）、`abort-session`、
`check-session-status`、`get-active-sessions`、`get-pending-permissions`（带 `sessionId` 只查该会话，
不带则跨会话汇总当前用户的待审批项）、`claude-permission-response` / `codex-permission-response`。

聊天 WebSocket 与 `/api/agent` 的 writer 都会包在 `LoggingWriter` 中。重连时
按 `seq` 补回日誌，并补送尚未定稿的串流段落。`session-message-log-cleanup`
每天按保留期限与总大小清理整个会话的日誌，收藏与执行中会话不清理。
