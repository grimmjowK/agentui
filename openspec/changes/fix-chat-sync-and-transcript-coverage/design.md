## Context

聊天页的内容来自 `claude-sessions.provider.ts` 对 `~/.claude/projects/<proj>/<sid>.jsonl` 的归一化；页面的"自动更新"依赖一条链路：

```
chokidar (轮询 6s)
  → onUpdate → synchronizeProviderFile
  → queuePendingWatcherUpdate (debounce 500ms / max 2s)
  → 广播 projects_updated (走 /ws，与聊天流同一条连接)
  → WebSocketContext.setLatestMessage
  → useProjectsState effect → setExternalMessageUpdate(+1)
  → useChatSessionState effect → sessionStore.refreshFromServer
```

已基于 4 个项目的存量转录（workhelper 18434 行、claudecodeui 15990 行、monet 10432 行、dm-cli 4731 行）逐行复刻归一化逻辑做过统计，两类问题都有实测依据，不是推测：

- **同步**：链路上三处会静默丢更新（见 Decisions D1–D3）。`MainContent.tsx:126` 的 Chat 是 `hidden` 常驻、切 tab 不卸载，所以"切一下就好"并非重挂载生效，而是 Shell 挂载时执行 `claude --resume` 顺手 touch 了转录文件，触发了一次新广播——副作用，不是设计。
- **覆盖度**：整体吞吐仅 31%–44%（18434→6214、15990→6977、10432→3230、4731→1485）。其中 `attachment` 占 40%+ 的行且**完全没有归一化分支**；`system` 的 compact 边界、用户按 Esc 的 `[Request interrupted` 同样不可见。

约束：

- 现有 `MessageKind` 联合类型被后端 `server/shared/types.ts:75` 与前端 `src/stores/useSessionStore.ts:19` 两处各自声明，新增 kind 需双边同步，且所有 `switch (msg.kind)` 消费者都要兜底。
- 已有三处同类先例（`isLocalCommand`、`isLocalCommandStdout`、`isCompactSummary`）采用的是"`kind: 'text'` + 布尔标记"，而非新增 kind。
- 转录是只读的外部产物，格式由 CLI 决定，随版本演进；解析必须对未知字段/子类型容错。

## Goals / Non-Goals

**Goals:**

- 已挂载的 Chat 视图在转录变更后可靠刷新，不依赖手动刷新页面或切 tab。
- 消除 `activeSessions` 泄漏导致的"永久不再刷新"状态。
- 让终端可见、聊天页缺失的三类内容变为可见：用户中断、有语义的 attachment、会话压缩边界。
- 改动对旧数据、旧前端向后兼容，不引入新依赖。

**Non-Goals:**

- 不调整 watcher 的 6 秒轮询间隔或 debounce 参数（只影响延迟，不影响正确性）。
- 不渲染纯元数据行：`pr-link`、`cost-state`、`ai-title`、`last-prompt`、`mode`、`permission-mode`、`atis-latch`、`queue-operation`。
- 不改动 `entry.sessionId === sessionId` 过滤器（105 个转录文件全量校验，首行 sessionId 与文件名 100% 一致，唯一被丢的 `file-history-snapshot`/`delta` 本就不该渲染）。
- 不试图补救 `thinking` 内容缺失：workhelper 1240 条、monet 754 条 `thinking` 字段全为空串，是 CLI 写入时就清掉的，解析器无能为力。
- 不重构 WebSocket 传输层协议；只改前端分发。

## Decisions

### D1：前端消费 `updatedSessionIds` 数组

**现状**：`sessions-watcher.service.ts:151` 广播时同时发出 `updatedSessionId`（首项，兼容字段）和 `updatedSessionIds`（完整集合）。`grep updatedSessionIds src/` 的结果是——**只有 `src/types/app.ts:68` 的类型声明，无任何消费者**。`useProjectsState.ts:427` 只比对单数字段。

**后果**：同一 debounce 窗口内只要有另一个 session 的文件也变了（后台跑着另一个 CLI、Shell tab 顺手 touch），当前会话抽不到"第一名"，刷新被整个跳过。这正是"偶发"的来源。

**决定**：前端改为优先按 `updatedSessionIds` 做集合判定，缺失时回退单值。后端广播载荷不动。

**备选**：让后端为每个 session 单独广播一条。否决——放大消息量，且 `projects` 全量载荷会被重复传输多份。

### D2：项目级事件与聊天流事件分流

**现状**：`WebSocketContext.tsx:40,82` 用一个 `useState` 承接**所有** `/ws` 消息：

```js
const [latestMessage, setLatestMessage] = useState(null);
websocket.onmessage = (e) => setLatestMessage(JSON.parse(e.data));
```

**后果**：React 把同一批内的多次 `setState` 合并为最后一次，前面的消息连 effect 都不触发。流式输出时每秒几十条 `content_block_delta`，挤进来的 `projects_updated` 几乎必然被下一条覆盖。`useProjectsState` 的 `lastHandledMessageRef` 只能防重复处理，防不了丢失。

**决定**：在 `WebSocketContext` 内按消息类型分流为两个独立状态槽——`latestMessage`（现有，聊天流消费者继续用，签名不变）与新增的 `latestProjectEvent`（承接 `projects_updated` / `loading_progress`）。`useProjectsState` 改订阅后者。

**备选 A**：把 `latestMessage` 改成有界队列 + 游标。否决——所有消费者（`useChatRealtimeHandlers`、`TaskMasterContext`、`ChatInterface`）都要改消费方式，改动面远大于收益。

**备选 B**：项目级事件另开一条 WebSocket 连接。否决——多一条连接要处理独立的鉴权、重连、生命周期，为一个分发问题付了传输层的代价。

**代价**：`projects_updated` 高频时仍可能自我覆盖（同一 tick 内连发两条只处理后一条）。可接受：该消息携带全量 `projects` 快照，后一条是前一条的超集，丢前面那条无信息损失；`updatedSessionIds` 的丢失由 D3 的兜底覆盖。

### D3：`activeSessions` 加过期回收

**现状**：`useSessionProtection.ts` 的集合只在 `complete` / `error` / `check-session-status` 返回 idle 时清除（`useChatRealtimeHandlers.ts:158,267,336`）。而这些事件走的正是 D2 里会被覆盖的单槽。

**后果**：ws 中途断线或 `complete` 丢失一次，该 sessionId 永远留在集合里，此后所有 `projects_updated` 对它都不再触发刷新——**直到刷新页面重建 state**。这解释了"必须刷新才好"。

**决定**：把集合从 `Set<string>` 改为 `Map<string, number>`（sessionId → 最后活动时间戳），`has()` 查询时顺带判定是否已过期。阈值取 5 分钟。清理走惰性判定而非定时器，避免多一个需要 cleanup 的 interval。

**备选**：加 `setInterval` 定期扫描清理。否决——惰性判定同样正确，且不引入需要在 unmount 时清理的副作用。

### D4：新消息用布尔标记而非新增 `MessageKind`

**决定**：中断、attachment、compact 边界一律以 `kind: 'text'` 产出，通过 `NormalizedMessage` 上的新布尔/元数据字段区分：

| 内容 | 产出 | 标记 |
|---|---|---|
| `[Request interrupted` | `kind:'text'`, `role:'user'` | `isInterrupted: true` |
| `attachment.type = file` / `edited_text_file` | `kind:'text'` | `attachmentKind`, `attachmentPath` |
| `attachment.type = plan_mode` / `plan_mode_exit` | `kind:'text'` | `attachmentKind` |
| `attachment.type = invoked_skills` / `queued_command` | `kind:'text'` | `attachmentKind`, `attachmentDetail` |
| `system` + `subtype: compact_boundary` | `kind:'text'` | `isCompactBoundary: true` |

**理由**：这是本仓库已有的三处先例（`isLocalCommand`、`isLocalCommandStdout`、`isCompactSummary`）所用的模式，与之一致。新增 kind 则需同步后端 `MessageKind` 联合、前端 store 的同名联合、`useChatMessages` 的 `switch`、以及每个按 kind 分支的消费者——为纯展示差异付了类型系统的代价。`NormalizedMessage` 已有 `[key: string]: unknown` 索引签名，新字段天然透传。

**代价**：`ChatMessage` 上的布尔标记会继续增长。若将来这类标记超过 ~8 个，再统一收敛为一个 `variant` 字段。已在 tasks 里留了注记。

### D5：attachment 用白名单而非黑名单

实测 `attachment.type` 共 17 种，`hook_success` 一种就占 4673/5648。白名单只放行 6 种有用户语义的子类型，其余（含未来 CLI 新增的）默认不渲染。黑名单会让每次 CLI 升级都可能漏出噪声。

### D6：中断从前缀过滤中摘出，不动其余两个前缀

`INTERNAL_CONTENT_PREFIXES` 现为 `['<system-reminder>', 'Caveat:', '[Request interrupted']`。实测 claudecodeui 那条里被该过滤器拦下的 14 条**全部**是 `[Request interrupted`——它是唯一的误伤。`<system-reminder>` / `Caveat:` 保持过滤。

## Risks / Trade-offs

- **[D2 分流遗漏消费者]** → `projects_updated` / `loading_progress` 的消费者若有遗漏，会静默失去更新。缓解：`grep -rn "latestMessage" src/` 已确认消费者共 5 处（`useProjectsState`、`ChatInterface`、`useChatRealtimeHandlers`、`TaskMasterContext`、`MainContent` 透传），逐一确认订阅的是哪一类；`TaskMasterContext.tsx:342` 也读 `latestMessage`，需核实它关心的消息类型属于哪一侧。
- **[D3 阈值误伤]** → 5 分钟无消息但实际仍在运行的会话（长时间无输出的工具调用）会被提前判为非活跃，触发一次外部刷新。影响可控：刷新只是多取一次服务端消息，不中断运行中的会话；且 `refreshFromServer` 在 `isLoading` 为真时本就跳过（`useChatSessionState.ts:504`）。
- **[D4 标记膨胀]** → 见 D4 代价段，已设定收敛触发条件。
- **[attachment 结构随 CLI 变化]** → 字段名/嵌套层级可能变更，导致解析取不到值。缓解：所有取值走可选链 + 类型守卫，取不到就不产出该条消息，不抛异常（spec 已有"未知子类型不报错"场景）。
- **[新消息改变历史对话的视觉密度]** → 存量会话打开后会多出若干条系统性消息（compact 边界、plan 模式切换）。这正是本次意图，但若某些会话里 `plan_mode` 频繁切换可能显得嘈杂。缓解：这些消息按紧凑的单行样式渲染，与普通气泡区分。

## Migration Plan

无数据迁移、无 schema 变更、无 API 契约破坏。

- 后端新增字段对旧前端表现为未知属性，被忽略。
- 前端 D1 的回退分支保证旧广播载荷仍可用。
- 回滚 = 回退代码，无需清理任何持久化状态。

验证方式：改动后用存量转录（上述 4 个 session）跑一次归一化，对比改动前后的消息条数增量是否与统计预期吻合（例如 claudecodeui 那条应新增 14 条中断 + 24 条 compact 边界 + `file`/`edited_text_file`/`plan_mode` 等约 180 条）。

## Open Questions

- `TaskMasterContext.tsx:342` 消费 `latestMessage` 的具体消息类型未逐条确认，D2 分流时需先确定它订阅哪一侧。实现阶段读该文件即可定，不阻塞。
- `attachment.type = file` 与 `edited_text_file` 的字段结构（文件路径在哪个键上）需实现时从真实转录取样确认。
