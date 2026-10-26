## Context

agentui 目前支持多个 Agent Provider（Claude、Codex、Cursor、Gemini），各 Provider 严格遵循统一的体系结构：
1. **统一 Provider 规范**：依据 `server/modules/providers/README.md`，每个 Provider 暴露 5 个标准 facet（`auth`, `mcp`, `skills`, `sessions`, `sessionSynchronizer`）。
2. **轻量运行时适配**：每个 Provider 拥有专注的运行时入口（如 `server/claude-sdk.js`、`server/openai-codex.js`、`server/gemini-cli.js`），负责子进程/SDK 调用、增量流式事件解析为统一 `NormalizedMessage`、中止与错误处理，并在 `server/routes/agent.js` 统一分发。
3. **基于 Transcript JSONL 的会话存储**：数据库中的 `sessions` 表仅记录元数据（`session_id`, `provider`, `project_path`, `jsonl_path`）。所有消息历史均由各 Provider 的 `sessions` facet 直接从本地原生 transcript 文件按行读取；会话索引由 `sessionSynchronizer` facet 扫描本地目录 upsert 入库。

Google 个人账号即将要求迁移至 Antigravity CLI（`agy`）。接入 Antigravity 时，应严格遵循上述成熟模式，**多参考 Claude 与 Codex 的实现方式，保持逻辑精简，坚决避免引入额外的复杂模块和数据库表变更**。

## Goals / Non-Goals

**Goals:**
- 提供轻量可靠的 Antigravity 运行支持，完成发送、增量流式输出、工具调用/结果展示、上下文续接、中止和错误映射。
- 遵循现有的 Provider 5-facet 架构规范，继承 `SkillsProvider` 与 `McpProvider` 基类，最大化复用已有逻辑。
- 遵循 Claude / Codex 会话历史模式，基于 Antigravity 本地原生 transcript 文件提供历史查询与同步索引，零数据库表变更。
- 保留 Gemini 历史与原 provider 身份，提供友好的迁移引导。

**Non-Goals:**
- **不在 SQLite 中新增任何消息级存储表，不引入数据库迁移脚本**。
- **不引入不必要的重型逻辑**：如 Codex 特有的 cross-terminal PTY handoff 或复杂租约锁（除非 Antigravity 确实需要终端接管）。
- **不在 headless 模式下伪造无法操作的前端交互式审批组件**，采用明确的 permissionMode 参数映射。
- 不自动安装 CLI，不越权访问或复制用户系统钥匙串/token。
- 不修改或改写旧 Gemini 会话数据。

## Decisions

### 1. 标准 Provider 规范接入（5-facet 架构）

在 `server/modules/providers/list/antigravity/` 下实现：
- `antigravity.provider.ts`：继承 `AbstractProvider`，注册 5 个 facet。
- `antigravity-auth.provider.ts`：检测 `agy` CLI 是否安装（检查 PATH 及 `~/.local/bin/agy` 等）及认证状态。
- `antigravity-mcp.provider.ts`：继承 `McpProvider`，支持 user/project 范围的 MCP 配置读写。
- `antigravity-skills.provider.ts`：继承 `SkillsProvider`，指定技能发现目录（如 `<workspace>/.agents/skills` 等），前缀为 `/`。
- `antigravity-sessions.provider.ts`：实现 `fetchHistory` 与 `normalizeMessage`，流式读取 transcript JSONL。
- `antigravity-session-synchronizer.provider.ts`：扫描 Antigravity 本地 transcript 日志目录，幂等写入 `sessionsDb`。

在 `provider.registry.ts` 和 `provider.routes.ts` 中完成标准注册。

### 2. 轻量子进程运行时（`server/antigravity-cli.js`）

参考 `server/gemini-cli.js` 和 `server/openai-codex.js`，创建轻量的运行模块：
- **进程管理**：使用 `spawn` 启动 `agy`，传入参数数组（消息内容、工作区路径、模型、原生会话 ID、权限参数等），避免 shell 拼接。
- **流式解析**：监听子进程 stdout，按行缓冲解析 NDJSON / 结构化事件；通过 `createNormalizedMessage` 实时生成标准统一消息并推送给 SSE/WebSocket writer。
- **会话中断与生命周期**：在 Map 中登记活跃进程，导出 `abortAntigravitySession(sessionId)`，挂载至服务端关闭清理钩子。
- **权限模式映射**：根据前端传来的 `permissionMode` 映射为对应的 CLI 参数（例如非交互安全模式或全放行模式），避免复杂的伪审批逻辑。
- **路由分发**：在 `server/routes/agent.js` 中新增 `provider === 'antigravity'` 分支，直接调用运行函数。

### 3. 会话历史完全对齐 Claude / Codex（Transcript 文件存储，零 DB 变动）

- **数据层契约**：完全复用已有的 SQLite `sessions` 表，仅写入一条元数据记录（`session_id`, `provider: 'antigravity'`, `project_path`, `jsonl_path` 等），**坚决不新建消息表或修改 DB schema**。
- **历史读取（`fetchHistory`）**：由 `antigravity-sessions.provider.ts` 从 `jsonl_path` 流式读取 transcript 并归一化返回，支持 `limit` 和 `offset` 分页。
- **会话续接**：新会话时生成或获取原生 conversation ID；后续轮次续接时，直接向 CLI 传递 `--resume <nativeConversationId>`（或等效参数）。
- **外部同步（`synchronize`）**：由 `antigravity-session-synchronizer.provider.ts` 扫描本地 transcript 日志目录（如 Antigravity 数据目录下的 transcript 文件），将离线或外部创建的会话同步至 `sessionsDb`。

### 4. 继承基类接入 MCP 与 Skills

- **Skills**：直接继承 `SkillsProvider`，只需重写 `getSkillSources(workspacePath)` 返回支持的技能目录即可，由基类自动完成 Markdown 前言提取与去重。
- **MCP**：直接继承 `McpProvider`，实现配置文件的读写和结构转换，复用现有的校验和异常保护机制。

### 5. 前端与配置最小侵入式接入

- 在 `server/shared/types.ts` 和 `src/types/app.ts` 中将 `'antigravity'` 加入 `LLMProvider` 联合类型。
- 在 `shared/modelConstants.js` 中增加 `ANTIGRAVITY_MODELS` 常量及默认模型。
- 更新前端 `useChatProviderState.ts`、`ProviderLoginModal.tsx` 及 Provider 切换空状态，确保用户可无缝选择 Antigravity 模型。
- Gemini 个人登录失败提示中添加切换至 Antigravity 的引导，原 Gemini 会话保持可读不可写的历史存档状态。

## Risks / Trade-offs

- **[CLI 未安装或路径不在 PATH]** → 在 Auth Provider 中增加默认查找路径（如 `~/.local/bin/agy`、`/opt/homebrew/bin/agy` 等），并在未安装时提供直接的错误指引。
- **[非交互输出格式兼容性]** → 解析器必须支持多行分块流缓冲与未知字段容忍，未知事件记录调试日志而不阻断主流程。
- **[原生恢复失败]** → 若 CLI 拒绝该会话 ID 恢复，明确向前端抛出提示，引导用户新建会话，而不静默退化。

## Migration Plan

1. 完善协议实测，记录 `agy` CLI 启动与恢复参数、事件结构样本。
2. 搭建标准 5-facet Provider 骨架并注册，实现 Auth、Skills、MCP。
3. 实现轻量运行时 `server/antigravity-cli.js`、事件归一化与取消逻辑，接入 `server/routes/agent.js`。
4. 实现 `SessionsProvider`（读 transcript JSONL）与 `SessionSynchronizer`（目录扫描索引）。
5. 接入前端常量、选择器与登录提示。
6. 端到端验证：发送、流式接收、工具调用、中止、重启恢复历史。
