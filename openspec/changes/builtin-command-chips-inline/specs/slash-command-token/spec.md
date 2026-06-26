## MODIFIED Requirements

### Requirement: 选中命令后显示命令 Chip
当用户从下拉菜单中选中**任意**斜杠命令（包括 skills、custom 与 build-in 内置指令）时，系统 **SHALL** 在 textarea 上方显示该命令的可删除 Chip 标签，而不是立即执行、也不是切换到其它标签页。此行为对点击、Enter、Tab 三种选中方式一致生效。

#### Scenario: 选中 build-in 指令后出现 Chip
- **WHEN** 用户从命令菜单中选中一个 build-in 内置指令（如 `/model`、`/cost`、`/status`）
- **THEN** 输入区上方显示该指令的可删除 Chip
- **AND** 命令菜单关闭，textarea 获得焦点并清空，等待追加文本

#### Scenario: 选中 skill 命令后出现 Chip
- **WHEN** 用户从命令菜单中选中一个 skill 命令
- **THEN** 输入区上方显示该命令的可删除 Chip

#### Scenario: Chip 上显示关闭按钮
- **WHEN** 输入区中存在命令 Chip
- **THEN** Chip 上可见一个 `×`（关闭）按钮

## ADDED Requirements

### Requirement: build-in 指令在 chat 内处理而非切换到终端
系统 **SHALL** 在 chat 内处理 build-in 内置指令，**SHALL NOT** 因 build-in 指令（含 `/model`）切换到 Shell/终端标签页。

#### Scenario: 输入 /model 不再切到终端
- **WHEN** 用户在 chat 中输入或选中 `/model`
- **THEN** 系统不切换到 Shell 标签页
- **AND** `/model` 固化为 Chip，提交后在 chat 内联渲染处理

#### Scenario: 其它 build-in 指令同样留在 chat
- **WHEN** 用户提交任意 build-in 指令的 Chip
- **THEN** 其结果在 chat 内呈现，不发生标签页切换（`/config` 打开设置面板等既有跳转行为除外）
