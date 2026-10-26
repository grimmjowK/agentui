## 1. CLI 探测与协议样本记录

- [x] 1.1 确认 `agy` 可执行路径解析规则（PATH、`~/.local/bin/agy`、`/opt/homebrew/bin/agy` 等），确认版本与登录状态检测方式。
- [x] 1.2 确认非交互子进程调用参数（消息、工作区路径、模型、多轮恢复参数等），验证 stdout 增量事件格式并保存单元测试。

## 2. 标准 Provider 5-Facet 接入

- [x] 2.1 新增 `server/modules/providers/list/antigravity/antigravity.provider.ts` 继承 `AbstractProvider`，串联 5 个标准 facet。
- [x] 2.2 实现 `antigravity-auth.provider.ts`，报告 CLI 安装及认证状态。
- [x] 2.3 继承 `McpProvider` 实现 `antigravity-mcp.provider.ts`，支持 user/project 范围配置读写。
- [x] 2.4 继承 `SkillsProvider` 实现 `antigravity-skills.provider.ts`，配置技能根目录（如 `.agents/skills`）与 `/` 指令前缀。
- [x] 2.5 在 `provider.registry.ts`、`provider.routes.ts`、`server/shared/types.ts` 和 `src/types/app.ts` 中注册 `antigravity`。

## 3. 轻量 CLI 运行时（`server/antigravity-cli.js`）

- [x] 3.1 参考 `gemini-cli.js` 实现 `spawnAntigravity`，使用参数数组启动子进程，隔离 stdout 与 stderr。
- [x] 3.2 实现增量事件解析器，将流式事件实时转换为统一的 `NormalizedMessage`（文本增量、工具调用/结果、终态完成）。
- [x] 3.3 实现进程生命周期管理、活动映射登记、`abortAntigravitySession` 取消函数及服务端关闭回收。
- [x] 3.4 在 `server/routes/agent.js` 中接入 `provider === 'antigravity'` 运行时分发。

## 4. 会话历史与同步器（对齐 Claude / Codex 模式）

- [x] 4.1 实现 `antigravity-sessions.provider.ts`，从本地原生 transcript JSONL 流式读取历史消息并实现分页，零数据库表变更。
- [x] 4.2 实现 `antigravity-session-synchronizer.provider.ts`，扫描本地 transcript 目录并将会话元数据 upsert 至 `sessionsDb`。
- [x] 4.3 支持基于原生 conversation ID 恢复多轮对话；验证原 Gemini 会话历史隔离读取。

## 5. 前端界面与常量集成

- [x] 5.1 在 `shared/modelConstants.js` 中增加 `ANTIGRAVITY_MODELS` 常量和默认模型。
- [x] 5.2 更新前端 `useChatProviderState.ts` 与模型/Provider 切换空状态组件。
- [x] 5.3 在设置与 Agent 选择界面中接入 Antigravity 选项。

## 6. 验证与回归

- [x] 6.1 运行类型检查（`npm run typecheck`）与代码风格检查（`npx eslint`）。
- [x] 6.2 编写与运行单元测试（路径解析、解析器事件转换、Session 历史读取与 MCP 注册）。
- [x] 6.3 回归测试 Gemini、Claude、Codex 现有功能，确保不受影响。

## 7. 会话链路修复

- [x] 7.1 补齐项目接口、侧栏、分页、刷新与路由恢复的 Antigravity 会话支持。
- [x] 7.2 使用原生会话 ID 登记进程并及时索引项目归属，修复终端续接及运行状态。
- [x] 7.3 修复流式完成重复输出、历史分页，并补充真实协议和会话持久化回归测试。

## 8. 旧数据目录兼容

- [x] 8.1 在聊天与终端恢复旧 Antigravity 会话前，将缺失的 SQLite 轨迹快照幂等迁移到 agy CLI 数据目录。
- [x] 8.2 使用真实旧会话验证终端可加载原对话，并补充迁移回归测试。

验证记录（2026-10-23）：
- 38 项后端回归测试与 1 项前端会话列表测试通过。
- 类型检查、修改文件 ESLint、前后端生产构建通过（Vite 提示已有大包体积警告）。
- 使用本机真实 agy 和临时应用数据库验证两轮原生 ID 续聊、上下文保留、数据库重开后的历史读取与项目列表；未进行浏览器界面操作验收。

验证记录（2026-10-26）：
- 定位旧版 Antigravity 轨迹位于 `~/.gemini/antigravity`、agy CLI 仅从 `~/.gemini/antigravity-cli` 加载。
- 将 `d9bc5a72-f456-487a-9724-6db040c4d79a` 的轨迹数据库迁移到 CLI 数据目录后，agy 成功读取原对话。
- 新增聊天与终端共用的幂等 SQLite 快照迁移，并覆盖在线 WAL 数据和重复恢复测试。
