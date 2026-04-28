# Slash Command Token

## Purpose

定义斜杠命令在输入区被选中、展示、编辑、提交和渲染的交互行为，让用户可先选中命令为 Chip、再追加自由文本作为参数提交。

## Requirements

### Requirement: 选中命令后显示命令 Chip
当用户从下拉菜单中选中斜杠命令时，系统 **SHALL** 在 textarea 上方显示该命令的可删除 Chip 标签，而不是立即执行或发送命令。

#### Scenario: 选中命令后出现 Chip
- **WHEN** 用户通过点击、Enter 或 Tab 从命令菜单中选中一个斜杠命令
- **THEN** 输入区上方显示一个带命令名的 Chip（如 `/commit`）
- **AND** 命令菜单关闭
- **AND** textarea 获得焦点且内容为空，等待追加文本输入

#### Scenario: Chip 上显示关闭按钮
- **WHEN** 输入区中存在命令 Chip
- **THEN** Chip 上可见一个 `×`（关闭）按钮

### Requirement: 命令 Chip 可被删除
系统 **SHALL** 允许用户在发送前删除待发命令 Chip。

#### Scenario: 通过 × 按钮删除
- **WHEN** 用户点击命令 Chip 上的 `×` 按钮
- **THEN** Chip 被移除
- **AND** textarea 保持焦点，已输入内容不变

#### Scenario: 通过 Backspace 删除
- **WHEN** 存在命令 Chip
- **AND** textarea 获得焦点，光标在位置 0 且内容为空
- **THEN** 按下 Backspace 键后 Chip 被移除

### Requirement: 用户可在命令 Chip 后追加文本
系统 **SHALL** 允许用户在存在命令 Chip 时在 textarea 中继续输入自由文本，该文本将作为命令的参数/上下文。

#### Scenario: 追加文本被保留
- **WHEN** 存在命令 Chip
- **AND** 用户在 textarea 中输入文字
- **THEN** 该文字作为追加输入被保存并在 textarea 中可见

### Requirement: 发送时携带追加输入执行命令
用户提交含有命令 Chip 的输入框时，系统 **SHALL** 以追加文本作为参数执行对应命令。

#### Scenario: 带追加文本提交
- **WHEN** 存在命令 Chip
- **AND** 用户已输入追加文本
- **AND** 用户提交（按 Enter 或点击发送按钮）
- **THEN** 以追加文本作为 `rawInput` 参数执行命令
- **AND** 提交后 Chip 和 textarea 均被清空

#### Scenario: 无追加文本时提交
- **WHEN** 存在命令 Chip
- **AND** textarea 内容为空
- **AND** 用户提交
- **THEN** 不带额外参数执行命令

### Requirement: 已发送消息只展示追加文本
斜杠命令发送后，系统 **SHALL** 在对话消息气泡中只展示用户的追加文本，而不展示命令背后的完整 Markdown Prompt。

#### Scenario: 消息气泡显示追加文本
- **WHEN** 用户提交带有追加文本「请使用约定式提交格式」的命令 Chip
- **THEN** 对话中的用户消息气泡显示「请使用约定式提交格式」
- **AND** 完整 Prompt Markdown **不**出现在气泡中

#### Scenario: 无追加文本时消息气泡回退为命令名
- **WHEN** 用户提交无追加文本的命令 Chip
- **THEN** 用户消息气泡显示命令名（如 `/commit`）
