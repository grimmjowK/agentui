## ADDED Requirements

### Requirement: 交互式内置命令在真实 CLI 进程上执行
当用户在 chat 触发交互式内置命令（首期为 `/model`）时，系统 **SHALL** 将该命令送入真实 CLI 进程（经由 Shell 已有的 PTY 链路）执行，而不是使用服务端的假实现。

#### Scenario: /model 经真实 CLI 执行
- **WHEN** 用户在 chat 触发 `/model` 命令
- **THEN** 系统将 `/model` 送入真实 CLI 进程的 PTY 会话执行
- **AND** 不调用 `/api/commands/execute` 的服务端假实现来返回硬编码模型列表

### Requirement: 渲染真实 CLI 返回的交互式选择列表
当真实 CLI 进程经 PTY 返回交互式选择列表（如 `❯ N. label` 形式、带 `esc to cancel` / `enter to select` 页脚）时，系统 **SHALL** 将其解析并渲染为可选择的选项列表。

#### Scenario: 选择列表可视化展示
- **WHEN** PTY 输出中出现编号选项与交互页脚
- **THEN** 系统将每个编号选项渲染为一个可点击的选项控件
- **AND** 复用 Shell 已有的提示解析逻辑（`checkBufferForPrompt`）识别选项

#### Scenario: 非交互输出不误渲染
- **WHEN** PTY 输出中不存在编号选项或交互页脚
- **THEN** 系统不渲染选择列表控件

### Requirement: 将用户选择写回真实 CLI 进程
用户在交互式选择列表中做出选择后，系统 **SHALL** 把所选选项写回对应 CLI 进程的 stdin，使 CLI 继续执行。

#### Scenario: 点击选项写回 stdin
- **WHEN** 用户点击交互式选择列表中的某个选项
- **THEN** 系统通过 PTY 的 `input` 通道把该选项序号写回真实 CLI 进程（`sendInput(opt.number)`）
- **AND** 写回后清除当前选择列表控件

#### Scenario: 取消选择
- **WHEN** 用户选择取消（Esc）
- **THEN** 系统向 CLI 进程写回 Esc（`\x1b`）
- **AND** 清除当前选择列表控件
