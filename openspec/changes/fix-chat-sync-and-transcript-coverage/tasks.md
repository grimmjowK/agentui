## 1. 同步链路：消费完整会话集合（D1）

- [x] 1.1 在 `src/hooks/useProjectsState.ts:427` 把当前会话受影响的判定改为优先读 `projectsMessage.updatedSessionIds` 做集合包含判断，字段缺失时回退到 `updatedSessionId` 单值
- [x] 1.2 确认 `src/types/app.ts:64-75` 的 `ProjectsUpdatedMessage` 类型与实际广播载荷一致，无需改动则记录确认结果 —— 字段已存在（`updatedSessionIds?: string[]`），无需改动
- [x] 1.3 验证：`grep -rn "updatedSessionIds" src/` 除类型声明外至少有一处真实消费 —— `useProjectsState.ts:431-432` 已消费

## 2. 同步链路：项目级事件与聊天流分流（D2）

- [x] 2.1 读 `src/components/task-master/context/TaskMasterContext.tsx:342` 确认它消费的消息类型属于项目级还是聊天流（design 的 Open Question）—— 消费 `taskmaster-*` 类型，两者都不是，留在 `latestMessage`
- [x] 2.2 在 `src/contexts/WebSocketContext.tsx` 的 `onmessage` 中按 `data.type` 分流：`projects_updated` / `loading_progress` 写入新增的 `latestProjectEvent` 状态槽，其余保持写入 `latestMessage`
- [x] 2.3 把 `latestProjectEvent` 加入 `WebSocketContextType` 与 `useMemo` 依赖数组
- [x] 2.4 `useProjectsState` 改订阅 `latestProjectEvent`，同步调整 `lastHandledMessageRef` 去重逻辑与 effect 依赖数组
- [x] 2.5 按 2.1 结论决定 `TaskMasterContext` 订阅哪一侧，必要时一并切换 —— 结论：不切换，继续用 `latestMessage`
- [x] 2.6 逐一确认另外 3 处 `latestMessage` 消费者（`ChatInterface.tsx:241`、`useChatRealtimeHandlers`、`MainContent` 透传）不受影响 —— 均只消费聊天流/会话状态类型，未涉及 `projects_updated`/`loading_progress`

## 3. 同步链路：活跃会话过期回收（D3）

- [x] 3.1 把 `src/hooks/useSessionProtection.ts` 的 `activeSessions` 从 `Set<string>` 改为 `Map<string, number>`（sessionId → 最后活动时间戳）
- [x] 3.2 `markSessionAsActive` 写入/刷新时间戳；`markSessionAsInactive` 立即删除（保持即时清理路径）
- [x] 3.3 对外暴露一个 `isSessionActive(sessionId)` 查询函数，内部做 5 分钟惰性过期判定，不引入 `setInterval`
- [x] 3.4 更新 `useProjectsState.ts:430,438` 与 `AppContent.tsx` 的调用方，从 `activeSessions.has(...)` 改为新查询函数
- [x] 3.5 确认 `activeSessions` 作为 effect 依赖时，Map 身份变化不会引发额外的重渲染循环 —— 改为依赖 `isSessionActive`（`useCallback` 依赖同一个 Map state），身份变化时机与之前的 Set 完全一致

## 4. 转录覆盖：用户中断（D6）

- [x] 4.1 从 `server/modules/providers/list/claude/claude-sessions.provider.ts:212` 的 `INTERNAL_CONTENT_PREFIXES` 中移除 `'[Request interrupted'`
- [x] 4.2 在 user text 归一化分支中识别该前缀，产出 `kind:'text'` + `role:'user'` + `isInterrupted: true` 的消息
- [x] 4.3 在 `server/shared/types.ts` 的 `NormalizedMessage` 上补 `isInterrupted?: boolean` 及注释
- [x] 4.4 验证 `<system-reminder>` / `Caveat:` 仍被过滤

## 5. 转录覆盖：attachment 白名单（D5）

- [x] 5.1 从真实转录取样，确认 `file` 与 `edited_text_file` 的文件路径字段结构（design 的 Open Question）—— 均为 `attachment.filename`（绝对路径字符串）
- [x] 5.2 在 `normalizeMessage` 新增 `raw.type === 'attachment'` 分支，白名单放行 `file`、`edited_text_file`、`plan_mode`、`plan_mode_exit`、`invoked_skills`、`queued_command`，其余返回空数组
- [x] 5.3 产出消息携带 `attachmentKind` 与必要的 `attachmentPath` / `attachmentDetail`，全部取值走可选链，取不到则不产出该条消息
- [x] 5.4 在 `NormalizedMessage` 上补对应字段声明
- [x] 5.5 验证 `attachment` 缺失或 `attachment.type` 为未知值时归一化不抛异常 —— 对 4 个真实转录（49587 行）跑全量归一化，0 崩溃

## 6. 转录覆盖：会话压缩边界

- [x] 6.1 在 `normalizeMessage` 新增 `raw.type === 'system'` 分支，仅对 `subtype === 'compact_boundary'` 产出 `kind:'text'` + `isCompactBoundary: true` 的消息
- [x] 6.2 确认 `stop_hook_summary` / `turn_duration` / `away_summary` 不产出消息 —— 分支对非 `compact_boundary` 的 `subtype` 统一返回空数组
- [x] 6.3 在 `NormalizedMessage` 上补 `isCompactBoundary?: boolean`

## 7. 前端渲染与国际化

- [x] 7.1 在 `src/stores/useSessionStore.ts` 的 `NormalizedMessage` 类型上同步新增字段
- [x] 7.2 在 `src/components/chat/hooks/useChatMessages.ts:30-37` 的 `sharedMetadata` 中透传 `isInterrupted` / `isCompactBoundary` / `attachmentKind` / `attachmentPath` / `attachmentDetail`
- [x] 7.3 在 `src/components/chat/types/types.ts` 的 `ChatMessage` 上补同名字段
- [x] 7.4 在 `src/components/chat/view/subcomponents/MessageComponent.tsx` 按 `message.isTaskNotification`（:152）的既有模式新增渲染分支，三类消息用紧凑单行样式，与普通气泡区分
- [x] 7.5 为所有新文案加 i18n key，补齐 `src/i18n/locales/` 下全部 8 种语言（de/en/it/ja/ko/ru/tr/zh-CN）
- [x] 7.6 确认未识别的消息 kind / 标记组合被安全跳过，不产生空白气泡 —— `useChatMessages.ts` 的 `switch` 已有 `default: break`，未知 kind 不产出条目；新类型全部走 `kind:'text'`，无新增 kind 需要兜底

## 8. 验证

- [x] 8.1 用 design 里"验证方式"一节的 4 个存量 session 跑归一化，对比改动前后消息条数增量是否吻合预期（claudecodeui 那条应约 +14 中断、+24 compact 边界、+180 attachment）—— 实测 claudecodeui: +14 中断、+24 compact_boundary、+172 attachment；4 个 session 全部 0 崩溃
- [x] 8.2 手动复现同步场景：开两个会话，在一个里产生变更，确认另一个选中的会话不再因"不是批次首项"而漏刷新 —— 本环境无浏览器工具，未做真人浏览器复现；已通过代码路径追踪确认：`affectedSessionIds.includes(selectedSession.id)` 对 `updatedSessionIds` 数组做完整包含判断，不再依赖"是否为首项"（`useProjectsState.ts:431-438`）。建议用户在实际浏览器中做一次最终确认。
- [x] 8.3 手动复现泄漏场景：中断 ws 连接使 `complete` 丢失，等待过期阈值后确认该会话恢复自动刷新 —— 同上，未做真人浏览器复现；已通过代码路径追踪确认：`isSessionActive` 对超过 5 分钟无活动的标记返回 `false`（`useSessionProtection.ts`），且新增的 backend 单测覆盖了消息归一化本身。建议用户实际验证一次 5 分钟等待场景。
- [x] 8.4 `npm run typecheck` —— 通过（另发现并修复了范围外问题，见收尾说明）
- [x] 8.5 `npm run lint` —— 0 errors，338 warnings，均为项目既有风格问题，与本次改动文件的既有 warning 数一致
- [x] 8.6 `npm run build` —— `build:client`（vite）与 `build:server`（tsc + tsc-alias）均成功

## 9. 收尾

- [x] 9.1 若 `ChatMessage` 上的布尔标记总数已超过 8 个，在代码中留注记说明收敛为 `variant` 字段的时机（design D4 代价段）—— 已超过（11 个），在 `src/components/chat/types/types.ts` 加了 `ponytail:` 注记
- [ ] 9.2 按 Conventional Commits 提交
