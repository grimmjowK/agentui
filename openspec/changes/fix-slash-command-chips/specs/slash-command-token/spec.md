## MODIFIED Requirements

### Requirement: 选中命令后显示命令 Chip
当用户从下拉菜单中选中**任意** `/` 斜杠命令（内置即时命令除外）时，系统 **SHALL** 在 textarea 上方显示该命令的可删除 Chip 标签，而不是立即执行、也不是把命令文本插入 textarea。此行为对点击、Enter、Tab 三种选中方式一致生效。

#### Scenario: 通过回车选中命令后出现 Chip
- **WHEN** 命令菜单打开且高亮某个斜杠命令
- **AND** 用户按下 Enter（回车）键
- **THEN** 输入区上方显示一个带命令名的 Chip（如 `/commit`）
- **AND** 命令菜单关闭
- **AND** textarea 获得焦点且内容为空，等待追加文本输入

#### Scenario: 通过点击或 Tab 选中命令后出现 Chip
- **WHEN** 用户通过点击或 Tab 从命令菜单中选中一个斜杠命令
- **THEN** 输入区上方显示该命令的 Chip
- **AND** 命令文本**不**被插入 textarea

#### Scenario: Chip 上显示关闭按钮
- **WHEN** 输入区中存在命令 Chip
- **THEN** Chip 上可见一个 `×`（关闭）按钮

#### Scenario: 内置即时命令不固化为 Chip
- **WHEN** 用户选中一个返回 `type: "builtin"` 的内置命令（如 `/clear`）
- **THEN** 该命令按原有方式即时执行
- **AND** 不显示 Chip

### Requirement: 发送时携带追加输入执行命令
用户提交含有命令 Chip 的输入框时，系统 **SHALL** 以追加文本作为参数执行对应命令，并将命令名与追加文本一起组装后发送给 CLI。

#### Scenario: 回车键携带追加文本发送
- **WHEN** 存在命令 Chip
- **AND** 用户已在 textarea 中输入追加文本（含换行追加的内容）
- **AND** 用户按下 Enter（回车）键发送
- **THEN** 系统以 `命令名 + 追加文本` 组装为 `rawInput` 执行命令
- **AND** 追加的全部文本（含换行后追加的内容）作为参数传给 CLI，不被丢弃
- **AND** 提交后 Chip 和 textarea 均被清空

#### Scenario: 点击发送按钮携带追加文本
- **WHEN** 存在命令 Chip 且已输入追加文本
- **AND** 用户点击发送按钮
- **THEN** 行为与回车发送一致，追加文本随命令发送

#### Scenario: 无追加文本时提交
- **WHEN** 存在命令 Chip
- **AND** textarea 内容为空
- **AND** 用户提交
- **THEN** 不带额外参数执行命令
