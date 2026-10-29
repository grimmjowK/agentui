## Why

当前 agentui 通过 Gemini CLI 子进程提供对话。用户已遇到个人账号登录被拒绝并要求迁移至 Antigravity 的错误。安装新 CLI 并不能自动修复 agentui：现有实现依赖 Gemini 的启动参数、事件结构、认证文件和会话存储。

需要新增独立的 Antigravity CLI 接入。参考现有 Claude 和 Codex 的设计方式，遵循现有的 Provider 标准规范与 Transcript 会话存储模式，在复用统一消息协议和聊天界面的同时，保持代码精简，避免引入多余模块与数据库迁移，并保留原有 Gemini 历史。

## What Changes

- **标准 Provider 注册**：基于 `server/modules/providers/README.md` 规范，实现标准 5-facet（auth, mcp, skills, sessions, sessionSynchronizer）的 `AntigravityProvider`。
- **轻量 CLI 运行时**：新增 `server/antigravity-cli.js`，参考 `gemini-cli.js` 与 `openai-codex.js`，管理 `agy` 子进程生命周期、增量流式解析为统一 `NormalizedMessage`、中止（`abortSession`）及退出码错误映射。
- **对齐现有会话历史机制**：对齐 Claude/Codex/Gemini 模式，复用现有 SQLite `sessions` 元数据表，历史消息直接从 Antigravity 本地原生 transcript JSONL 流式读取与分页，通过原生 conversation ID 恢复多轮对话，**不新增数据库表与迁移**。
- **复用基类接入 MCP 与 Skills**：继承 `McpProvider` 与 `SkillsProvider` 基类，快速接入 Antigravity 的配置读写与技能目录扫描（如 `.agents/skills` 等）。
- **保留旧 Provider 与迁移指引**：保留 `gemini` provider 和历史；遇到旧个人账号停用时提供新建 Antigravity 会话的明确指引，不改写旧会话。

## Capabilities

### New Capabilities

- `antigravity-chat-runtime`: Antigravity provider 注册、轻量子进程运行、增量流式消息标准化、权限模式参数映射与进程生命周期管理。
- `antigravity-session-continuity`: 基于原生 conversation ID 恢复多轮上下文；由 sessions provider 读取本地原生 transcript JSONL 历史；通过 session synchronizer 实现索引同步。
- `antigravity-provider-configuration`: CLI 安装与认证状态检测、模型常量与启停配置、MCP 配置与 Skills 自动发现。

### Modified Capabilities

无。现有 Gemini、Claude 与 Codex 相关实现保持隔离，旧数据不自动改写。

## Impact

- **后端**：
  - 新增 `server/modules/providers/list/antigravity/`（5 个 facet 类及 provider 包装类）。
  - 新增 `server/antigravity-cli.js`（轻量运行适配器）。
  - 更新 provider registry、provider 路由、`server/routes/agent.js` 分发、进程清理与退出回收。
  - 更新共享类型 `server/shared/types.ts` 中的 `LLMProvider`。
- **前端**：
  - 更新 `src/types/app.ts` 中的 `LLMProvider`。
  - 更新模型常量 `shared/modelConstants.js`、聊天状态 `useChatProviderState.ts`、登录弹窗与空状态提示。
  - 项目接口、侧栏、分页、刷新和会话路由增加 Antigravity 分组，沿用现有会话管理逻辑。
- **运行依赖**：用户已安装并登录的 `agy` CLI（默认查找路径包括 PATH、`~/.local/bin/agy` 等）。
