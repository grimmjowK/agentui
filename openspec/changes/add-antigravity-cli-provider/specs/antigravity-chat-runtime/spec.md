## ADDED Requirements

### Requirement: 独立运行入口
系统 SHALL 使用独立 `antigravity` provider 在服务端启动 Antigravity CLI 子进程，并绑定请求的项目目录、模型与会话。

#### Scenario: 发送新会话消息
- **WHEN** 用户选择 Antigravity 并发送消息
- **THEN** 系统 SHALL 启动 `agy` 子进程，传入所选模型、工作区路径及消息，并将输出归属于当前应用会话

#### Scenario: CLI 不可用
- **WHEN** `agy` CLI 未安装或找不到可执行路径
- **THEN** 系统 SHALL 返回可操作的安装提示及路径建议，不启动其他 provider 作为隐式替代

### Requirement: 标准化流式事件
系统 SHALL 实时读取子进程 stdout 输出，按行缓冲解析结构化事件，并转换为统一 `NormalizedMessage` 格式推送给前端。

#### Scenario: 分块流式文本与工具输出
- **WHEN** 文本或工具事件跨多个 chunk 到达或单 chunk 包含多个事件
- **THEN** 系统 SHALL 完整解析事件，生成唯一且稳定的消息 ID，实时推送增量 delta 与工具执行状态，且终态时不重复展示文本

#### Scenario: 异常与未知事件隔离
- **WHEN** 输出包含诊断日志、未知事件或 stderr 信息
- **THEN** 系统 SHALL 记录诊断日志；非关键未知事件被安全忽略，错误信息转换为统一错误消息，不污染助手正常回复

### Requirement: 运行终态和取消
系统 SHALL 准确跟踪每个运行中的会话进程，并在正常完成、报错退出或用户中止时保证产生唯一终态，彻底回收进程资源。

#### Scenario: 用户中止
- **WHEN** 用户主动点击中止按钮
- **THEN** 系统 SHALL 终止对应会话的子进程（发送 SIGTERM / SIGKILL），保留已接收内容，标记为中止状态

#### Scenario: 异常退出
- **WHEN** CLI 进程在未完成前异常退出或返回非零退出码
- **THEN** 系统 SHALL 捕获退出码并映射为可读的错误信息，结束等待状态，不将该次运行标为成功

### Requirement: 明确的权限模式映射
系统 SHALL 将前端的权限模式（如 `bypassPermissions` 或默认安全模式）映射为 CLI 对应的命令行执行参数。

#### Scenario: 非交互模式执行
- **WHEN** 在非交互模式下运行会话
- **THEN** 系统 SHALL 传递对应的安全或放行参数，遇到拒绝时展示 CLI 原生错误提示，不伪造无法响应的交互审批控件
