# Design

## Context

动机见 proposal.md。2026-10-19 的代码检查与本机版本查询提供以下事实：

- `server/openai-codex.js` 通过 `resolveCodexExecutablePath` 将 App 内二进制交给 SDK；当前安装的 SDK 实际启动 `exec --experimental-json`，写入提示后关闭 stdin，没有双向审批桥接。
- `server/shared/codex-cli-path.ts` 优先 CODEX_CLI_PATH、ChatGPT.app、Codex.app，再返回 PATH 命令；聊天在 PATH 分支却让 SDK 自行找内置程序，仍可能偏离统一路径。
- shell 服务优先 CODEX_CLI_PATH 或 `/opt/homebrew/bin/codex`，未使用共享解析器；`resume ID || codex` 会把恢复失败变成新会话。
- 本机 App 内为 0.155.0-alpha.9，全局 npm 为 0.139.0，项目依赖为 0.143.0。这只是观测版本，不等于已验证最低兼容版本。
- Claude 使用 canUseTool 和 permission_request 回调；前端审批回复只有 Gemini/Claude 分支，Codex 缺少完整返回链路。
- shell 缓存键不含 provider 或用户；聊天与终端冲突目前只警告，不阻止双写；复用 PTY 不会重读历史。

官方 [app-server 协议](https://learn.chatgpt.com/docs/app-server#approvals) 定义服务端审批请求及客户端回复。目标 App 内 alpha 版本仍须实测；初始化、方法名和回复枚举以版本化 schema 与真实样本确认，不能只根据网页认定本机支持。

## Goals / Non-Goals

**Goals:** 保持现有 provider 身份、thread ID 和历史；补齐真实双向审批；让应用管理的运行具备确定的生命周期与交接边界。

**Non-Goals:** 不把官方 App 的插件、连接器和所有界面功能复制进 agentui；不实现 TUI 的 app-server 镜像，不接管外部 Codex 进程，不迁移 Antigravity，不重构所有 provider，不自动安装、升级 CLI 或更改全局安全设置。

## Decisions

### 1. 统一运行描述，而非只替换命令字符串

扩展共享解析器返回绝对可执行路径、来源、版本、配置根目录及能力探测结果。优先级保持显式配置 → macOS App → PATH；PATH 解析为实际文件，所有入口显式使用同一结果，禁止 SDK 另选 bundled binary。检查可执行性，显式路径错误和所选版本不兼容直接报错，不静默换程序。缓存按路径、文件变更标识和配置根目录失效。

聊天、终端、认证与模型服务共享此描述。传参使用数组；PTY 直接启动 Codex 或使用严格的平台转义，避免空格路径注入。普通 shell 的任意用户命令不改写。运行配置变化只在旧运行结束后生效。

只改终端硬编码虽然简单，但不能解决 SDK 回退和后续版本漂移，因此不采用。

### 2. Codex 聊天采用 app-server 的 stdio 双向协议

新增独立进程/JSON-RPC 适配层，每个活动聊天会话使用独立的受管理运行实例，顺序处理该 thread 的回合，配置或用户之间不共享进程。初始化完成后才允许 thread/start 或 thread/resume、turn/start；命令、文本、工具、使用量和终态归一化至现有消息边界。稳定 item ID 用于增量更新，最终消息不重复写入。

必须处理分片行、请求与通知交错、stderr、未知扩展、协议错误、启动期限、turn/interrupt、异常退出及子进程回收。用户中止与底层完成竞争时只生成一个应用终态。待审批不视为卡死；协议看门狗与审批计时分开。

保留 `queryCodex` 等对外入口以减少调用方改动，但内部不再以 exec SDK 作为交互聊天通道。不自动回退旧 exec，因为那会再次丢失审批能力。迁移稳定后再审计 SDK 依赖是否仍被使用。

### 3. 审批桥接使用具名请求和显式决定

目标协议至少验证 commandExecution/requestApproval 和 fileChange/requestApproval；额外 permissions/requestApproval 按探测能力启用。未知需要回复的请求明确失败，不无条件接受。

pending registry 键包含认证用户、运行实例、thread、turn、原始 JSON-RPC request ID；浏览器使用独立不透明 requestId。服务端保留原 ID 类型并验证归属、状态和允许决定。卡片按请求提供的合法决定展示一次批准、会话批准（仅支持时）、拒绝和取消；额外权限只能授予请求子集。不要将不同协议决定压扁为全局 allow 布尔值。

前端使用明确 Codex 回复类型，不再落入 Claude 分支；共享审批展示组件但不混用 provider 的 pending registry。仅收到服务端确认后结束 pending 状态。审计记录保存必要范围与结果，不保存凭据。

默认模式采用 workspace-write + on-request；acceptEdits 保留现有 workspace-write + never，界面明确不申请额外权限；bypassPermissions 仅在用户明确选择时使用 danger-full-access + never。此次不偷偷改变已有模式含义。宿主禁止提权与应用未桥接审批要分别呈现。

### 4. 审批断线和清理

默认审批有效期 10 分钟，服务端可配置并返回 expiresAt；断线保留请求且不自动批准，用户重连时恢复卡片。超时、turn 中止、进程退出、交接和服务关闭令请求失效；协议仍可通信时回复拒绝/取消，否则清理并通知前端。重复决定幂等，旧进程请求不得被新进程接收。服务重启不恢复旧可审批请求，只保留可展示的历史结果。

只在前端弹出对话框不足以让运行暂停/继续，因此待审批状态由后端持有。

### 5. 同一 thread 单写者与显式交接

在服务端建立 Codex 会话协调器。写入锁以 Codex 配置根目录与 thread ID 为身份，记录认证用户、规范化项目、owner(chat/terminal)、运行实例和状态；防止不同 UI 用户指向同一底层 thread 时绕过互斥。PTY 缓存另按用户、provider、项目、thread 和运行配置隔离。新建运行先占临时身份，获得 thread ID 后原子登记。

聊天空闲时可交接：失效待审批 → 关闭 app-server 并确认退出 → 从明确 ID 启动 TUI。聊天活动或待审批时提示等待或中止，不静默杀进程。终端持锁期间可浏览聊天历史，但发送必须先交接；由于 PTY 无可靠结构化“空闲”信号，用户显式结束终端后才释放，不猜测屏幕文本。保留聊天草稿，退出与历史刷新完成后再提交。

终端回到聊天：关闭终端并确认进程组结束 → 失效旧 PTY 缓冲 → 刷新会话历史 → app-server resume 原 ID。删除 Codex 的恢复失败自动新建分支。WebSocket 断线不等于进程退出，仍持锁，重连回到原 owner。服务正常退出回收所有运行；异常重启根据运行登记及 OS 进程身份核验遗留进程，不能仅凭 PID 盲杀或无条件释放，无法确认时显示阻塞及手动断开入口。

备选是继续仅警告双写，无法保证一致性；另一个备选是两个页面共享同一进程，但原生 TUI 与 app-server 不是可任意互挂的界面，因此本次选择可靠交接。外部终端/官方 App 并发修改仅提示并刷新，不承诺跨应用锁。

### 6. 兼容与验证门槛

首批实现任务用临时工作区对候选 CLI 完成初始化、原生 ID 恢复、真实命令/文件审批、批准后执行、拒绝、取消、退出及 TUI 恢复，记录最低已验证版本、OS、schema 与脱敏 fixtures。额外权限能力单独标记。未通过必需能力的版本禁用新聊天通道并给出错误，不标为兼容。

回归覆盖旧 Codex 历史、实时/历史去重、跨用户审批、断线重连、竞态交接、PATH/App/显式路径、含空格路径及其他 provider。浏览器真实审批和聊天→终端→聊天是最终验收，不能以单元测试或 CLI 参数存在替代。

## Risks / Trade-offs

- [alpha 协议漂移] → 版本化能力矩阵、协议样本和不兼容提示；不从版本字符串推断能力。
- [审批错配或扩大授权] → 服务端验证请求归属及允许的决定，保留原请求语义，默认拒绝未知情况。
- [迁移改变事件与历史格式] → 稳定 item ID 去重，保留旧历史 reader，比较真实回放与新实时结果。
- [交接中断用户工作] → 活动回合不自动交接，保留草稿，仅在明确结束运行后转移写入权。
- [残留进程或重复启动] → 原子锁、运行登记、进程组清理和异常恢复核验；验收竞态和崩溃路径。
- [用户期待 App 全功能] → 展示运行来源并说明同 thread 的交互入口边界，不承诺 App 专属功能。

## Migration Plan

1. 完成协议实测与兼容记录，再实现共享解析器、app-server 和审批桥接。
2. 保留 provider ID、既有线程与历史目录；新增运行/审批元数据不得改写原始 transcript 或迁移凭据。
3. 接入交接协调器与前端交互，清理旧受管进程后启用新路径；用真实 UI 验收并运行项目检查。
4. 回滚时结束新运行并取消 pending 请求，回退运行代码，保留原历史；不得把回退后的 exec 通道标为支持交互审批。
