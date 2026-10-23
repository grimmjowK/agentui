## Context

`feat/unify-codex-runtime-and-approvals`（单一 commit `cf78bb84`）把 Codex 聊天从 `codex exec
--experimental-json` 单向流换成 `codex app-server` 长驻进程 + JSON-RPC 双向协议，统一了聊天/终端/
认证的可执行文件解析，并接通了交互式审批（`item/commandExecution/requestApproval`、
`item/fileChange/requestApproval`、`item/permissions/requestApproval`）。

该分支已有的协议实测记录（`docs/codex-runtime-protocol.md`）基于 2026-10-20 在
`/Applications/ChatGPT.app/Contents/Resources/codex`（报告版本 `0.155.0-alpha.9`）上的手动验证。
本地环境自那之后发生了两处变化：

1. 同一 ChatGPT.app 实际回报的版本字符串是 `0.155.0-alpha.9.2`（带补丁号），与硬编码的
   `0.155.0-alpha.9` 不相等。
2. 用户已将本机 homebrew 的 `codex` 升级到 `0.163.0`，并用该版本重新生成了 `app-server
   generate-json-schema`，确认协议 schema 中 `CommandExecutionApprovalDecision` 新增了
   `acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment` 两种对象型决定，`app-server`
   顶层也新增了 `daemon`/`proxy` 子命令（0.155 时期的 `--help` 没有）。

分支的 `getCodexRuntimeInfo()` 用 `cached.version === 'codex-cli 0.155.0-alpha.9'` 做精确字符串
比较来决定 `capabilities.status` 是 `'protocol-tested'` 还是 `'unverified'`；`queryCodex()` 在
非 `protocol-tested` 时直接 `throw`，没有任何回退路径。这意味着该分支在当前本机环境（以及几乎任何
其他未精确匹配该字符串的机器）上会让聊天完全不可用——与分支本身"修好 Codex 聊天跨机器一致性"的
目标直接冲突。

`CodexOwnership`（`server/modules/codex-runtime/ownership.ts`）用 `CODEX_HOME/agentui-runs/<hash>`
目录 + `owner.json` + 双重进程身份核对（服务端 PID 和子进程 PID 的"身份签名"，而非单纯 PID 存活）
实现跨进程独占锁，设计本身是稳健的（不会盲目 kill 或复用一个巧合复用的 PID），但目前唯一的恢复路径
是报错信息里提示用户"核对 `owner.json` 后手动删除目录"。桌面端打包给非技术用户后，这条路径不可操作。

## Goals / Non-Goals

**Goals:**
- 让分支在任何达到最低可用版本的 Codex CLI 上都能工作，不再因为版本号精确不匹配而整体拒绝服务。
- 给异常锁一个不依赖人工删除磁盘目录的安全恢复路径，同时不削弱现有的双重进程身份校验。
- 用 0.163.0 的真实协议 schema 核实并更新审批决定的处理范围，记录任何有意过滤的决定类型及理由。
- 对 `codex app-server daemon`/`proxy` 子命令做一次调研并给出明确结论（复用、部分复用、或不复用）。

**Non-Goals:**
- 不重新设计分支已确立的架构（长驻 app-server 进程、JSON-RPC、审批卡片 UI、
  聊天/终端统一可执行文件解析）。
- 不扩大审批范围到浏览器审批、Antigravity 接入、其他 provider 的权限行为——这些在原分支的
  proposal 里已明确排除，本变更延续该边界。
- 不追求对任意未来 Codex CLI 版本的协议 100% 前向兼容；只保证"版本不达标时优雅降级"，而非
  "自动适配协议结构变化"。
- 不实现 `daemon`/`proxy` 子命令的调用代码，除非调研确认其语义明确且能直接替代现有锁设计——
  如果语义不清楚或需要较大改动，本变更只记录结论，留给后续变更处理。

## Decisions

### D1: 版本门禁从精确字符串匹配改为最低版本号比较

**决策**：把 `capabilities.status` 的判定从
```ts
cached.version === 'codex-cli 0.155.0-alpha.9' && process.platform === 'darwin'
```
改为：解析版本号为可比较的结构（主.次.修订，忽略 `-alpha.N` 等预发布后缀用于比较基线，但保留
用于展示），与一个可配置的最低版本常量比较。达到最低版本 → `'protocol-tested'`；低于最低版本 →
`'unverified'`，此时 `queryCodex` 不再直接 `throw`，而是把 `unverified` 状态通过聊天提醒
（`task_notification`，`status: 'warning'`）展示给用户，并仍然尝试走 app-server 协议——因为
app-server 协议本身是向后兼容的 JSON-RPC，不是"实测过的版本列表"决定能不能跑，而是能不能保证
"已知行为符合预期"。真正解析失败（版本号格式不认识）才视为不支持并报错。

**理由**：
- 精确匹配在实践中等同于"只有正好这个补丁版本能用"，而 Codex CLI 的发行节奏明显比这个判断
  宽松得多（同一台机器上 App 和 PATH 版本就能差出两个小版本号）。
- 协议层面的新增字段/方法通常是**加法式**的（新增审批决定类型、新增子命令），不是破坏性的；
  真正需要人工重新验证的是"是否有以前假设成立、现在不成立的字段"，这由 D3 的 schema diff 来发现，
  不该用版本号死等。

**考虑过的替代方案**：
- 维护一个"已知兼容版本白名单"（多个精确字符串）：维护成本随发行节奏线性增长，且任何新版本
  默认不可用，体验上与现状差别不大，否决。
- 完全去掉版本检查，总是尝试：丢失了"已知某版本协议异常"时主动预警的能力，否决——
  至少要保留"低于最低版本/不认识的版本号"这两类明确异常的拦截。

### D2: 异常锁恢复——TTL 兜底 + 显式管理操作，而非自动强杀

**决策**：在现有的双重进程身份校验（`processIdentity()` 判断服务端 PID 和子进程 PID 是否仍是
"同一个"进程，而非"有没有一个同 PID 的进程存在"）基础上，为 `owner.json` 增加一个
`claimedAt` 时间戳。当双重身份校验**无法确认**对方已退出（两边进程仍"看起来活着"，但已经超过
一个可配置 TTL 仍未续期/未完成）时：
1. 不自动删除或强杀——身份不确定时删除锁等于默许"可能还在跑的会话"被另一方接管，这正是
   `ownership.ts` 现有设计要防止的事。
2. 暴露一个只读的诊断端点/CLI 子命令，输出锁的 `owner`、`claimedAt`、距今时长、双重身份校验的
   具体结论（"服务端已确认退出"/"子进程已确认退出"/"两者均无法确认"），替代现在"自己翻
   `owner.json` 猜"的方式。
3. 当双重身份校验**明确**双方都已退出（`serverGone && childGone`，这是现有 `claim()` 里已有的
   判断），继续走现有的"recovering 目录 + 重新核对 generation + 原子 rename"回收流程——这部分
   不改动，本身已经是正确的。
4. 仅在双重身份校验结论不确定、且超过 TTL 时，诊断端点才允许一个**显式的、需要管理员确认**的
   强制释放操作，并在释放前再次核对一次身份（防止在诊断和释放之间，原进程又恢复响应）。

**理由**：
- 当前设计"宁可卡死也不误放"的保守取向是对的（避免跨用户/跨会话的并发写入破坏数据），
  本决策不改变这个取向，只是把"人工翻 JSON 文件猜测"换成"结构化诊断信息 + 有门槛的显式操作"。
- 纯 TTL 自动释放（不管身份校验结果）会重新引入"误判存活进程为已退出"的风险，否决。

**考虑过的替代方案**：
- 完全自动化恢复（后台定时任务扫描过期锁并释放）：把本该由人决策的"是否安全"的判断权交给
  一个定时器，风险收益比差，否决，尤其是桌面端这种缺乏运维监控的场景。

### D3: 用 0.163.0 协议 schema 校验分支的审批决定集合

**决策**：以 `codex app-server generate-json-schema`（本机已验证可在 0.163.0 上运行）生成的
`CommandExecutionRequestApprovalResponse`/`FileChangeRequestApprovalResponse`/
`PermissionsRequestApprovalResponse` 为准，对照 `CodexApprovals.add()` 里硬编码的
```ts
decisions = isPermissions ? ['accept', 'decline']
  : Array.isArray(advertised) ? advertised.filter(d => ['accept','acceptForSession','decline','cancel'].includes(d))
    : ['accept', 'decline', 'cancel'];
```
确认：
- `acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment` 这两个对象型决定继续被过滤
  （不在候选列表里展示），因为它们需要 UI 展示"建议的策略修正内容"并让用户审阅后再决定是否
  采纳，这超出本变更范围，分支的 proposal 本身也写了"不默认放宽权限"。
- 但要新增一个显式检查：当服务器 `availableDecisions` 过滤后**为空**（例如某个请求只提供了
  这两种对象型决定、没有任何简单枚举值），必须 fallback 到 `['decline']`（安全默认，不是
  "无候选项时卡死等 10 分钟超时"），并记录一次警告日志，而不是让 `add()` 产出一个没有任何
  可选项的审批卡片。
- 把本次核实结果写入 `docs/codex-runtime-protocol.md` 的追加记录，标注版本、日期、schema
  diff 结论，不覆盖原有 0.155-alpha 的实测记录（保留历史对照）。

**理由**：过滤未支持的决定类型本身没问题，但"过滤后可能导致候选列表为空"是分支当前实现
没有处理的边界情况，必须补上，否则遇到新版本协议返回更多未支持的决定类型时会卡死。

### D4: `daemon`/`proxy` 子命令——先调研后决定，不预先假设复用

**决策**：作为本变更的一个任务项（非阻塞主线修复），运行
`codex app-server daemon --help` 与 `codex app-server proxy --help`
并记录其语义。根据结果：
- 若 `daemon` 提供的是"后台共享进程 + 多 client 连接"且已经内建单写者/并发语义 →
  记录为后续变更的候选项，本变更不替换 `ownership.ts`（避免在同一个变更里叠加两个高风险改动）。
- 若语义不符（例如只是进程管理工具，不涉及写入互斥）→ 记录结论"不适用"，关闭此调研项。

**理由**：`ownership.ts` 当前的实现是自研但设计严谨（双重身份校验、原子 rename、recovering
目录防竞态）。替换掉它需要同等严谨地验证官方机制覆盖了所有这些边界情况，调研和替换应该分两步，
不要在"修复版本门禁"这个变更里顺带做架构级替换。

### D5: Codex 审批卡片复用 Claude 兜底布局，不裸转 JSON

**决策**：`PermissionRequestsBanner.tsx` 当前对 `request.provider === 'codex'` 的分支直接
`<pre>{JSON.stringify(request.input, null, 2)}</pre>`，与 Claude 审批卡片风格割裂。改为复用
Claude 审批的兜底布局（`ShieldAlertIcon` + "Permission required" 标题 + 结构化摘要 +
可折叠的 "View request details"）：
- 命令审批（`item/commandExecution/requestApproval`）：主体展示 `input.command`
  （代码块样式）、`input.cwd`，有 `input.reason` 时展示原因；完整 `input` 收进可折叠详情。
- 文件审批（`item/fileChange/requestApproval`）：展示涉及的文件路径/变更摘要；完整 `input`
  收进可折叠详情。
- 其他/未知 Codex 请求：退回"标题 + 可折叠完整 JSON"，但沿用 Claude 兜底的卡片外壳，而不是
  裸 `<pre>`。
- 保留分支已有的 Codex 专属逻辑：过期倒计时（`context.expiresAt` + 每秒 tick）、
  `submitted` 去重、按 `context.decisions` 动态渲染决定按钮——这些是 Codex 独有的，不在
  Claude 兜底布局里，继续保留。

**理由**：这是纯展示层改动，数据已经透传到前端（`request.input` 是后端 `{...params, item}`
的展开，`command`/`cwd`/`reason` 字段都在），不需要改后端或协议。复用 Claude 兜底布局而不是
新写一套，既修了视觉又不引入新的样式分叉。

**考虑过的替代方案**：
- 为 `commandExecution`/`fileChange` 各写一个工具级定制面板（和 Claude 的 Bash/Edit 面板同级，
  通过 `registerPermissionPanel` 挂载）：效果最好（命令高亮、文件 diff），但工作量大，且
  Codex 的 `toolName` 是 RPC 方法名、需要额外的注册映射。留给后续独立变更，本变更先用兜底
  布局把"难看"降到"和 Claude 一致"。

### D6: 去除 ChatGPT.app 优先，运行来源只认独立 CLI

**背景**：一台测试 Mac 上出现"终端 `codex resume <id>` 能开、agentui 里切 Shell 报
`account/read failed: workspace routing discovery timed out (-32603)`"。排查发现
`resolveCodexExecutablePath` 在 macOS 上 **ChatGPT.app 内置 codex 优先**（原分支 `cf78bb84`
就带的策略），于是 agentui 实际拉起的是 App 内置的 `0.155.0-alpha.9.2`，而用户终端 `which
codex` 是独立安装的 `0.163.0`——**两者不是同一个二进制**。App 内置 codex 是桌面 App 的私有
运行时，从外部用用户的 `~/.codex` 环境拉起时，它的 `account/read` 工作区路由发现超时。

**决策**：删除 `MAC_APP_CODEX_PATHS` 与 darwin App 优先分支。解析顺序统一为
`CODEX_CLI_PATH`（显式）→ PATH 上的 `codex`，与 Claude 完全一致。PATH 上找不到时报错并提示
安装独立 CLI 或设置 `CODEX_CLI_PATH`，不退回 App 内置版本。`getCodexRuntimeInfo().source`
相应简化为 `configured | path`（`app` 枚举值无任何消费者，顺手移除）。

**理由**：
- Claude 从无此类问题，正因为它只认 PATH/显式配置的单一 CLI；Codex 要真正对齐就必须去掉 App
  优先。这也是用户多轮反复提出的诉求（"像 Claude 一样只访问 CLI"）。
- App 内置二进制与用户终端里的 codex 在版本、账号/workspace 配置、网络路由上都可能不一致，
  偷偷借用它正是本次超时的根源。报错提示装 CLI 比静默用一个行为异常的二进制更诚实。
- 影响面极小：`MAC_APP_CODEX_PATHS` 只在该文件内被引用，`source: 'app'` 无消费者。

**考虑过的替代方案**：
- App 降为最后兜底（`CODEX_CLI_PATH` → PATH → App）：保留只装 App 用户的可用性。否决——用户
  明确选择"直接报错提示装 CLI"，且"最后兜底"仍会在 PATH 恰好没有 codex 的机器上重新引入
  "借用 App 私有运行时"的风险。确有需要的用户可用 `CODEX_CLI_PATH` 显式指向 App。

### D7: paginated thread resume 规避 `thread/items/list` 未实现

**背景**：D6 修复后换用 PATH 的 codex 0.163.0，切历史会话到 Shell 又出现新报错
`thread/resume failed during TUI bootstrap: paginated_threads is not supported yet (-32601)`。
从本机 codex 二进制的内嵌字符串确认：0.163.0 的 thread 存储有 legacy 与 **paginated** 两种格式；
paginated thread 的全量历史加载（hydration）已弃用，要求改走分页 API `thread/turns/list` +
`thread/items/list`，而后者在该版本 **`is not supported yet`**。手动终端 `codex resume` 弹 picker
走的是 legacy 加载路径所以能开；agentui 非交互 resume 触发了 paginated 分支。

**决策**（只改 agentui 自身控制的 app-server 调用）：
- 聊天 `queryCodex` 的 `thread/resume` 加 `excludeTurns: true`（schema 合法参数，官方对 paginated
  thread 的推荐做法），只取元数据与 live-resume 状态；历史 agentui 另行从 `~/.codex` rollout 读取。
- 终端 preflight `prepareCodexTerminalThread` 的 `thread/read` 保持 metadata-only（不传
  `includeTurns`），加注释禁止将来误加。
- `codexTerminalFailure` 识别该报错，给出可读诊断（会话为分页格式、终端暂不能恢复、聊天仍可用）。

**诚实的能力边界**：终端那条报错来自 **PTY 里的原生 TUI**（`codex resume <id>`），TUI 内部自己
调 app-server，agentui **无法替它注入 `excludeTurns`**。因此 agentui 修好的是自身的聊天 resume
与 preflight；终端原生 TUI 对 paginated thread 的恢复，受限于 CLI 尚未实现 `thread/items/list`，
只能等 CLI 修复或把终端改为 app-server 驱动（上一轮用户未选的大改）。本决策把终端这类失败从
原始报错降级为可读诊断，不假装已解决。

**考虑过的替代方案**：
- 把终端改成 app-server 驱动、不再拉原生 TUI：能彻底绕过（agentui 自己 resume 时可带
  `excludeTurns` 并分页读取）。工作量大、改变"终端页是什么"，留作后续方向，本次不做。

## Risks / Trade-offs

- **[风险] 降低版本门禁后，某个未来 Codex 版本的协议发生破坏性变更（如移除某个审批方法）**
  → **缓解**：D3 的 fallback-to-decline 兜底确保"协议变化未知"时默认走最安全的拒绝路径，
  而不是卡死或误放行；同时 `docs/codex-runtime-protocol.md` 的追加记录机制让每次手动验证
  都留痕，方便未来排查"从哪个版本开始行为变了"。
- **[风险] TTL 诊断端点如果权限配置不当，可能被普通用户误用做强制释放，造成并发写入冲突**
  → **缓解**：强制释放操作要求显式确认，且释放前重新核对身份；该端点面向运维/高级用户，
  不在聊天/终端的常规 UI 路径上暴露。
- **[风险] 本变更建立在未合并的 `unify-codex-runtime-and-approvals` 分支之上，该分支本身
  还有"browser 审批未验收""terminal 断线不释放锁"等已知缺口（分支自己的协议文档已列出）**
  → **缓解**：本变更明确限定范围——只修版本门禁、锁恢复路径、审批决定兼容性这三个会直接
  导致"合并后立刻不可用"的问题，其余已知缺口保持分支文档里"未验收"的标注，不在本变更里
  一并解决，避免范围蔓延。
- **[Trade-off] 不自动化锁恢复意味着异常退出后仍需要一次人工操作（即便只是跑一个诊断命令
  而非直接改文件）** → 这是刻意的：数据正确性优先于全自动恢复的便利性，尤其是桌面端这种
  没有集中监控、无法快速响应误放行后果的部署场景。

## Migration Plan

1. 本变更的代码改动只涉及 `feat/unify-codex-runtime-and-approvals` 分支内部文件，不涉及
   已经合并到 `main` 的任何代码路径，因此没有面向生产的迁移/回滚问题——该分支本身尚未合并。
2. 实施顺序：D1（版本门禁）→ D3（审批决定兼容性，依赖重新生成的 schema）→ D5（审批卡片视觉，
   纯前端）→ D2（锁恢复诊断）→ D4（调研记录，无代码变更）。D1 和 D3 优先，因为它们是"合并后
   立刻不可用"级别的阻断项；D5 是前端展示修复，独立于后端改动；D2 是体验改进；D4 是后续决策
   输入，不阻塞本变更完成。
3. 验证：在本机用当前已装的 `0.163.0`（homebrew）和 ChatGPT.app 的 `0.155.0-alpha.9.2`
   分别跑一次聊天 + 终端 + 切换的手动场景，确认 D1 修复后两者都能进入 app-server 协议而不是
   被版本门禁拦截；并补一次"强制触发审批决定被过滤为空"的场景验证 D3 的 fallback。
4. 回滚：若 D1/D2/D3/D5 的改动引入新问题，可以单独回退某一个决策的 commit，彼此之间没有强耦合
   （D1 只改 `codex-cli-path.ts` 的判定逻辑，D2 只改 `ownership.ts` 新增诊断能力，D3 只改
   `approvals.ts` 的决定过滤逻辑，D5 只改 `PermissionRequestsBanner.tsx` 的 Codex 展示分支）。

## Open Questions

- `daemon`/`proxy` 子命令的具体语义尚未在本机验证（D4 调研项，留给 tasks 里的调研任务，
  结论会回填到 `docs/codex-runtime-protocol.md`）。
- D1 的"最低版本"常量具体取值（例如 `0.150.0` 还是更保守的值）需要在实施时结合
  `docs/codex-runtime-protocol.md` 已有的实测记录和本次新增的 0.163.0 验证结果共同确定，
  不在设计阶段预先写死。
- 分支文档里标注的"browser 审批未验收""terminal 断线不释放锁"等缺口是否需要后续独立变更
  跟进，留给合并该分支之后再排期，不在本设计的范围判断内处理。
