# server — 后端结构索引

Express + WebSocket 后端。根目录散落的 `.js` 文件是各 AI provider 的 CLI/SDK 适配实现，
子目录按职责分层。模块化业务（providers/projects/database/websocket）集中在 `modules/`，
详见 [modules/MODULES.md](./modules/MODULES.md)。

## 根目录文件

| 文件 | 职责 |
| --- | --- |
| `index.js` | 主服务器启动文件，初始化 Express、WebSocket 及提供商模块 |
| `cli.js` | CloudCLI 命令行入口，支持服务启动、沙箱管理与配置查询 |
| `load-env.js` | 从 `.env` 加载环境变量，确保数据库路径稳定统一 |
| `claude-sdk.js` | 基于 @anthropic-ai/claude-agent-sdk 封装，提供 Claude SDK 集成、会话管理与工具审批（审批绑定 `userId`） |
| `cursor-cli.js` | 子进程生成 Cursor CLI，处理工作空间信任验证与流式消息转发 |
| `openai-codex.ts` | Codex app-server 聊天执行层（JSON-RPC，使用 `codex-runtime/protocol` 生成型别），支持执行中插话 `turn/steer` |
| `antigravity-cli.js` | 子进程启动 Antigravity CLI（headless），`step_update` 经 `antigravity-tool-mapper` 映射为标准工具形状 |

以上执行层都由 `modules/providers/list/<id>/<id>-runtime.provider.ts` 包装为 `IProviderRuntime`，
聊天 WebSocket 与 `/api/agent` 只经 `providerRegistry` 分派，不直接 import 这些文件。

## 子目录

| 目录 | 职责 |
| --- | --- |
| `routes/` | HTTP 路由处理层，包含 Agent、Auth、Command、Git 等业务端点 |
| `services/` | 通知协调、推送订阅等业务服务及工具集合 |
| `database/` | SQLite 认证数据库及数据持久化 |
| `middleware/` | JWT 认证验证、API 密钥检查及请求鉴权中间件 |
| `utils/` | 命令解析、MCP 检测、插件加载器及运行时路径检测 |
| `constants/` | 配置常量定义（平台模式标识等） |
| `shared/` | TypeScript 类型定义、工具函数、接口规范及共享验证逻辑 |
| `modules/` | 模块化业务核心，见 [modules/MODULES.md](./modules/MODULES.md) |
