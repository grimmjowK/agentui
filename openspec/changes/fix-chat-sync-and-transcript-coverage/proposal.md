## Why

聊天页偶发与终端不同步：会话有新内容，但 Chat 视图不刷新，必须手动刷新页面或切一次 终端/聊天 才能看到。经对 4 个项目的存量转录逐行复核，根因有三处（广播只带单个 sessionId、`latestMessage` 单值槽被流式消息覆盖、`activeSessions` 永久泄漏），都在"变更 → 广播 → 前端重取"这条链路上。

同时，同一批统计显示转录里约 2/3 的行不产生任何 UI 消息。其中 `attachment` 的部分子类型（拖入文件、外部编辑、Plan 模式进出、skill 调用、排队命令）、`system` 的 compact 边界、以及用户按 Esc 的 `[Request interrupted` 都是终端里可见、聊天页完全缺失的内容，导致对话读起来有断层（AI "无故停住"、上下文"凭空压缩"）。

## What Changes

**同步链路修复**
- 广播的 `projects_updated` 消息：前端改为消费 `updatedSessionIds` 数组（目前只消费单数的 `updatedSessionId`，debounce 窗口内并发变更时当前会话会被整体跳过）。
- WebSocket 消息分发：`projects_updated` / `loading_progress` 这类项目级事件不再与聊天流式消息共用同一个 `latestMessage` 单值 state，避免高频 `content_block_delta` 覆盖掉项目更新事件。
- `activeSessions` 增加过期清理：会话在无活动超过阈值后自动移出集合，防止 `complete`/`error` 事件丢失时该会话永久不再触发外部刷新。

**转录覆盖度补齐**
- `[Request interrupted` 不再被 `INTERNAL_CONTENT_PREFIXES` 静默丢弃，改为归一化成一条可渲染的"已中断"消息。
- 新增 `attachment` 归一化分支，覆盖对用户有意义的子类型：`file`、`edited_text_file`、`plan_mode`、`plan_mode_exit`、`invoked_skills`、`queued_command`；其余子类型（`hook_success` 等噪声）继续忽略。
- 新增 `system` 归一化分支，覆盖 `compact_boundary`（会话压缩边界）。
- 前端为上述新消息类型提供渲染，并补充 i18n 文案。

非本次范围：`pr-link`、`cost-state`、`ai-title`、`last-prompt`、`mode`、`permission-mode`、`atis-latch`、`queue-operation` 等纯元数据行继续不渲染；watcher 的 6 秒轮询间隔不调整。

## Capabilities

### New Capabilities
- `chat-session-sync`: 转录文件变更如何可靠地传播到已挂载的 Chat 视图 —— 广播载荷的会话集合语义、项目级事件与聊天流事件的分发隔离、活跃会话状态的生命周期与过期回收。
- `transcript-message-coverage`: Claude 转录 JSONL 各条目类型到 UI 消息的归一化契约 —— 哪些类型必须产出可见消息、哪些必须忽略、中断与压缩边界的表达方式。

### Modified Capabilities
<!-- 无：现有 specs（gemini-*、slash-command-token）的需求不受影响 -->

## Impact

**后端**
- `server/modules/providers/list/claude/claude-sessions.provider.ts` — `normalizeMessage` 新增 `attachment` / `system` 分支，`INTERNAL_CONTENT_PREFIXES` 调整。
- `server/shared/types.ts`（或 `NormalizedMessage` 定义处）— 新增消息 kind。
- `server/modules/providers/services/sessions-watcher.service.ts` — 广播载荷语义确认（字段已存在，可能无需改动）。

**前端**
- `src/contexts/WebSocketContext.tsx` — 消息分发拆分。
- `src/hooks/useProjectsState.ts` — 消费 `updatedSessionIds`。
- `src/hooks/useSessionProtection.ts` — `activeSessions` 过期清理。
- `src/components/chat/view/subcomponents/MessageComponent.tsx` — 新消息类型渲染。
- `src/i18n/locales/*` — 新增文案。
- `src/types/app.ts` — 类型同步。

**兼容性**
- 无 BREAKING：广播消息保留现有单数字段；新增的消息 kind 对旧前端表现为未知类型（不渲染），不会报错。
- 无新增依赖。
