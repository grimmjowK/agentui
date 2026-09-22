## ADDED Requirements

### Requirement: 广播的会话集合必须被完整消费

服务端在一次 debounce 窗口内可能合并多个会话的文件变更，广播时 `updatedSessionIds` 携带完整集合、`updatedSessionId` 仅为兼容保留的首项。前端判断"当前选中会话是否受影响"时，SHALL 以 `updatedSessionIds` 集合为准；当该字段缺失时，SHALL 回退到 `updatedSessionId` 单值。

#### Scenario: 当前会话不是批次首项

- **WHEN** 一次 `projects_updated` 广播的 `updatedSessionIds` 为 `["A", "B"]`，用户当前选中会话为 `B`
- **THEN** 前端判定当前会话受影响，并触发一次该会话的消息重取

#### Scenario: 当前会话不在批次内

- **WHEN** 一次 `projects_updated` 广播的 `updatedSessionIds` 为 `["A", "C"]`，用户当前选中会话为 `B`
- **THEN** 前端不触发 `B` 的消息重取

#### Scenario: 兼容旧载荷

- **WHEN** 收到的 `projects_updated` 只有 `updatedSessionId: "A"`、没有 `updatedSessionIds`
- **THEN** 前端按单值 `"A"` 判定，行为与改动前一致

### Requirement: 项目级事件不得被聊天流式消息覆盖

WebSocket 传来的项目级事件（`projects_updated`、`loading_progress`）与聊天流式事件（`content_block_delta` 等高频消息）SHALL 通过互相独立的状态通道向订阅者分发，任一方的高频更新不得导致另一方的事件在 React 批处理中被丢弃。

#### Scenario: 流式输出期间到达项目更新

- **WHEN** 聊天正在流式输出（同一 tick 内到达多条流式消息），其间到达一条 `projects_updated`
- **THEN** 订阅项目级事件的消费者仍然收到并处理这条 `projects_updated`

#### Scenario: 同一 tick 内多条项目级事件

- **WHEN** 同一 React 批处理窗口内先后到达 `loading_progress` 与 `projects_updated`
- **THEN** 两类事件各自的消费者都被触发，不因共享状态槽而相互覆盖

### Requirement: 活跃会话标记必须可自动回收

`activeSessions` 用于在会话正在运行时抑制外部刷新。该集合中的条目 SHALL 在超过约定的无活动时长后自动移除，不得依赖 `complete` / `error` / 状态查询响应作为唯一的清理途径。

#### Scenario: 完成事件丢失后恢复刷新

- **WHEN** 会话 `A` 被标记为活跃，随后其 `complete` 事件未被前端收到，且超过无活动阈值
- **THEN** `A` 自动从 `activeSessions` 移出，后续针对 `A` 的 `projects_updated` 重新能触发消息重取

#### Scenario: 运行中的会话不被误清理

- **WHEN** 会话 `A` 被标记为活跃，且在阈值内持续收到该会话的流式或状态消息
- **THEN** `A` 保持在 `activeSessions` 中，外部刷新继续被抑制

#### Scenario: 正常完成即时清理

- **WHEN** 会话 `A` 被标记为活跃，随后收到该会话的 `complete` 事件
- **THEN** `A` 立即从 `activeSessions` 移出，不等待过期阈值
