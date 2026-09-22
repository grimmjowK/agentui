## ADDED Requirements

### Requirement: 用户中断必须在对话中可见

Claude 转录中以 `[Request interrupted` 开头的用户文本代表用户主动中断了本轮回复。归一化器 SHALL 将其产出为一条可渲染的消息，并标记为中断事件，而不得作为内部内容静默丢弃。

#### Scenario: 用户按 Esc 中断

- **WHEN** 转录中存在一条 `user` 文本，内容以 `[Request interrupted` 开头
- **THEN** 归一化结果包含一条对应消息，且该消息带有可供前端识别的中断标记

#### Scenario: 其他内部内容仍被过滤

- **WHEN** 转录中存在以 `<system-reminder>` 或 `Caveat:` 开头的用户文本
- **THEN** 归一化结果不包含对应消息

### Requirement: 有用户语义的 attachment 必须归一化

转录中的 `attachment` 条目 SHALL 按 `attachment.type` 区分处理：`file`、`edited_text_file`、`plan_mode`、`plan_mode_exit`、`invoked_skills`、`queued_command` 产出可渲染消息；其余子类型（包含但不限于 `hook_success`、`task_reminder`、`total_tokens_reminder`、`mcp_instructions_delta`、`skill_listing`、`agent_listing_delta`、`date_change`、`auto_mode`、`command_permissions`、`compact_file_reference`、`plan_file_reference`）不产出消息。

#### Scenario: 拖入文件

- **WHEN** 转录中存在 `attachment` 条目且 `attachment.type` 为 `file`
- **THEN** 归一化结果包含一条消息，携带该附件的文件标识信息

#### Scenario: 进入与退出 Plan 模式

- **WHEN** 转录中存在 `attachment.type` 为 `plan_mode` 或 `plan_mode_exit` 的条目
- **THEN** 归一化结果各包含一条消息，可区分是进入还是退出

#### Scenario: 噪声子类型被忽略

- **WHEN** 转录中存在 `attachment.type` 为 `hook_success` 的条目
- **THEN** 归一化结果不包含对应消息

#### Scenario: 未知子类型不报错

- **WHEN** 转录中存在 `attachment.type` 为当前实现未覆盖的值，或 `attachment` 字段缺失
- **THEN** 归一化正常完成、不抛出异常，且不为该条目产出消息

### Requirement: 会话压缩边界必须可见

转录中 `type` 为 `system` 且 `subtype` 为 `compact_boundary` 的条目代表上下文被压缩。归一化器 SHALL 为其产出一条可渲染的边界消息，使前后文断层在聊天页可被解释。

#### Scenario: 压缩边界

- **WHEN** 转录中存在 `type: "system"`、`subtype: "compact_boundary"` 的条目
- **THEN** 归一化结果包含一条标识"会话已压缩"的消息

#### Scenario: 其他 system 子类型

- **WHEN** 转录中存在 `subtype` 为 `stop_hook_summary`、`turn_duration` 或 `away_summary` 的 `system` 条目
- **THEN** 归一化结果不包含对应消息

### Requirement: 新消息类型必须可渲染且已国际化

归一化器新增的每一种消息 kind SHALL 在聊天界面有对应的渲染分支，且所有面向用户的文案 SHALL 通过 i18n 提供，至少覆盖项目现有的全部语言。

#### Scenario: 新类型渲染

- **WHEN** 聊天消息列表中包含中断、attachment 或压缩边界类型的消息
- **THEN** 每条消息以可读形式呈现，不出现空白气泡或原始 JSON

#### Scenario: 未知类型不破坏渲染

- **WHEN** 聊天消息列表中包含前端未识别的消息 kind
- **THEN** 该条目被跳过，其余消息正常渲染
