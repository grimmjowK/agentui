# Spec Delta

## Purpose

修正 `codex-runtime` 能力中版本兼容判定过于严格（精确字符串匹配）导致的整体不可用问题，
并要求运行诊断记录对官方替代机制的调研结论。

## MODIFIED Requirements

### Requirement: 运行能力可诊断
系统 SHALL 展示有效运行来源、版本及聊天审批能力状态；仅允许达到已验证最低版本的 Codex CLI
进入交互聊天，低于最低版本时 SHALL 明确标记为未验证并继续尝试运行、同时在聊天中展示警示，
无法解析版本号的情况 SHALL 视为不支持并报错，不得静默退回无审批运行。

#### Scenario: 版本低于已验证基线但可解析
- **WHEN** 所选程序回报的版本号低于当前记录的最低已验证版本
- **THEN** 系统继续尝试建立 app-server 连接并进入聊天，同时在聊天中展示"该版本未完整验证"的
  警示，不直接拒绝服务

#### Scenario: 版本号无法解析
- **WHEN** 所选程序回报的版本字符串不符合可比较的版本号格式
- **THEN** 聊天入口显示兼容性错误，禁止自动改用另一程序或宽松权限，不得当作已验证版本处理

#### Scenario: CLI 不支持必需协议
- **WHEN** 所选程序无法完成初始化或缺少必需的命令/文件审批能力
- **THEN** 聊天入口显示兼容性错误和有效版本，禁止自动改用另一程序或宽松权限

#### Scenario: 切换运行配置
- **WHEN** 用户改变可执行文件配置而已有会话仍存活
- **THEN** 系统提示需要结束旧运行再重连，新的聊天和终端均使用新配置，不在运行中替换程序

### Requirement: 所有 Codex 入口共享运行来源
系统 SHALL 对聊天、Codex 终端、认证和模型查询使用相同的可执行文件解析结果及 Codex 配置根目录，
解析顺序为显式配置（`CODEX_CLI_PATH`）优先、其次系统 PATH 上的 `codex`；SHALL NOT 自动优先选择
桌面 App（ChatGPT.app / Codex.app）内置的 codex 二进制。显式配置无效时 SHALL 报错而非静默替换；
PATH 上找不到 `codex` 时 SHALL 报错并提示安装独立 CLI 或设置 `CODEX_CLI_PATH`，不得退回任何 App
内置版本。

#### Scenario: 本机同时存在 App 内置与 PATH 的 codex
- **WHEN** 机器上既有 ChatGPT.app 内置 codex，又有 PATH 上独立安装的 codex，且未显式配置路径
- **THEN** 所有入口选择 PATH 上的 codex（与用户终端 `which codex` 一致），不选择 App 内置二进制

#### Scenario: 仅安装了 App、PATH 无独立 codex
- **WHEN** 机器上只有 ChatGPT.app，PATH 上没有独立的 codex，且未设置 `CODEX_CLI_PATH`
- **THEN** 系统报告找不到 codex 并提示安装 CLI 或设置 `CODEX_CLI_PATH`，不自动借用 App 内置二进制

#### Scenario: 显式指向 App 内置二进制
- **WHEN** 用户通过 `CODEX_CLI_PATH` 显式指向 App 内置的 codex
- **THEN** 系统使用该显式路径，保留给确有需要的用户

## ADDED Requirements

### Requirement: 官方共享运行机制有调研记录
系统 SHALL 在运行协议文档中记录对 `codex app-server` 官方子命令（例如共享后台进程或代理连接
相关的子命令）是否可替代自建的会话独占锁机制的调研结论，调研结论 SHALL 包含是否复用、复用范围
及理由，不得默认假定官方机制可用或不可用。

#### Scenario: 调研完成后记录结论
- **WHEN** 对官方子命令的语义调研完成
- **THEN** 运行协议文档中有一条明确记录，说明该子命令是否被本系统复用，以及未复用的原因（如语义
  不符或需要更大改动）

### Requirement: resume paginated thread 不触发未实现的全量加载
系统自身发起的 `thread/resume` SHALL 使用 `excludeTurns: true`（仅取元数据与 live-resume 状态），
终端 preflight 的 `thread/read` SHALL 保持 metadata-only（不传 `includeTurns`），以避免对 paginated
格式会话触发已弃用的全量 hydration 及尚未实现的分页读取 API（`thread/items/list`）。当终端原生
TUI 自身 bootstrap 因该分页读取能力缺失而失败时，系统 SHALL 给出可读的诊断信息，说明该会话的
分页格式当前 CLI 版本尚不能在终端恢复、聊天仍可用，而不是展示原始报错。

#### Scenario: 聊天 resume 一个 paginated 格式会话
- **WHEN** 用户在聊天中继续一个使用 paginated 存储格式的已有会话
- **THEN** 系统以 `excludeTurns: true` 发起 `thread/resume`，不触发 `paginated_threads is not
  supported yet` 报错，会话历史另行从 rollout 文件读取

#### Scenario: 终端 TUI 因分页读取未实现而启动失败
- **WHEN** 终端原生 TUI 在 bootstrap 时因 `thread/items/list` 未实现而报
  `paginated_threads is not supported yet`
- **THEN** 系统展示可读诊断：该会话为 paginated 格式、当前 CLI 版本尚不能在终端恢复、聊天仍可用、
  升级 CLI 后再试，而不是展示原始 RPC 报错
