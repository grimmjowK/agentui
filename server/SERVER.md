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
| `claude-sdk.js` | 基于 @anthropic-ai/claude-agent-sdk 封装，提供 Claude SDK 集成与会话管理 |
| `cursor-cli.js` | 子进程生成 Cursor CLI，处理工作空间信任验证与流式消息转发 |
| `gemini-cli.js` | 通过 PTY 启动 Gemini CLI，管理进程生命周期与 JSON 流解析 |
| `gemini-response-handler.js` | 解析 Gemini 流式 JSON 响应，处理 ANSI 转义与消息碎片 |
| `openai-codex.js` | OpenAI Codex SDK 集成，提供非交互式聊天会话与事件转换 |
| `sessionManager.js` | 管理 Gemini 会话状态与对话历史，支持本地文件持久化 |

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
