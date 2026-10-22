## Why

`feat/unify-codex-runtime-and-approvals` 统一了 Codex 聊天/终端/认证的可执行文件解析，并把聊天从 `codex exec`
单向流换成 `codex app-server` 双向协议，从而接通了交互式审批。方向正确，但分支当前实现在合并前会直接让聊天不可用，
且在服务端异常退出后需要人工介入才能恢复：

- `getCodexRuntimeInfo()` 用**精确字符串比较**(`codex-cli 0.155.0-alpha.9`)判定协议是否"已验证"，
  版本不匹配时 `queryCodex` 直接抛错、无回退。本机实测版本 (`0.155.0-alpha.9.2`、以及用户本机已升级到的
  `0.163.0`) 均不满足这个精确匹配，意味着分支在本机和任何其他机器上聊天功能都会被这道门直接拦掉——
  与分支本身要解决的"修好 Codex 聊天"目标相悖。
- `CodexOwnership`（会话独占锁）用文件系统目录 + PID 存活/身份比对实现，服务端非正常退出
  (`SIGKILL`、断电、容器被杀) 后留下的锁没有自动回收路径，只能让用户手动核对 `owner.json`
  并删除目录；桌面端打包分发给非技术用户后，这是不可操作的恢复路径。
- 分支的审批决定集合（`accept`/`acceptForSession`/`decline`/`cancel`）是当时在 `0.155-alpha` 上
  实测后收窄的；用户本机现有的 `0.163.0` 版本的 `app-server` 协议 schema 显示同一审批还新增了
  `acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment` 两种对象型决定，分支当前会把它们
  过滤掉而不做任何兼容处理，未重新验证这是否会在新版本上导致某些审批请求的候选决定被清空。
- `codex app-server` 新增了 `daemon`/`proxy` 子命令（0.155 时期没有），可能已经提供官方的单写者/
  共享连接语义，分支自建的目录锁 (`ownership.ts`) 有重复实现之嫌，合并前应先确认是否可以用官方机制
  简化或替代。

## What Changes

- 将版本门禁从精确字符串匹配改为**最低版本号比较**（semver 风格），未达标版本降级为警告 + 继续运行，
  而不是硬性拒绝；不可解析的版本号视为不支持并明确报错（而非静默放行）。
- 去除 macOS 上 **ChatGPT.app / Codex.app 内置 codex 优先**的解析策略，运行来源统一为
  `CODEX_CLI_PATH` → PATH 的 `codex`（与 Claude 一致）；修复 agentui 偷偷拉起 App 私有运行时、
  与用户终端 codex 不是同一个二进制、导致 `account/read` 工作区路由超时的问题。
- 聊天 `thread/resume` 加 `excludeTurns: true`、终端 preflight `thread/read` 保持 metadata-only，
  规避 paginated 格式会话触发 `paginated_threads is not supported yet`（CLI 尚未实现分页读取 API）；
  终端原生 TUI 对该类会话的恢复受限于 CLI、agentui 无法代注入参数，降级为可读诊断而非原始报错。
- 为 `CodexOwnership` 增加锁的**存活判定失败时的只读安全恢复**：在当前"双重进程身份核对"基础上，
  为长期无法确认対方是否存活的异常锁补充一个可配置的 TTL 兜底与明确的管理端点/CLI，减少对直接删除
  磁盘目录的依赖；不绕过现有的双重身份校验这一安全设计。
- 用本机已装的 `codex app-server generate-json-schema`（0.163.0）重新生成协议 schema 并存档，
  对照分支 `docs/codex-runtime-protocol.md` 的实测记录，补充/标注新增的审批决定类型，明确哪些
  需要在 `CodexApprovals` 里支持、哪些可以继续过滤但要有理由记录。
- 调研 `codex app-server daemon`/`codex app-server proxy` 子命令的实际语义，并给出结论：
  复用以简化或替代 `ownership.ts` 的自建锁，或记录为"已调研，暂不复用"及理由。
- 修复 Codex 审批卡片的视觉：当前分支把整个请求 `JSON.stringify` 后丢进一个 `<pre>`，与
  Claude 审批卡片风格割裂且难读。改为复用 Claude 审批的兜底布局（图标 + 标题 + 命令/文件
  摘要 + 可折叠的完整详情），让 Codex 审批与 Claude 审批视觉一致。本次不新增 Codex 专属
  的工具级定制面板（命令高亮、文件 diff 等），那部分留给后续独立变更。
- 不改变分支已确立的架构方向（长驻 app-server 进程、JSON-RPC 双向协议、审批卡片 UI）。

## Capabilities

### New Capabilities

（无新增能力；本变更修复 `unify-codex-runtime-and-approvals` 分支已定义的能力实现，不引入新的用户可见能力）

### Modified Capabilities

- `codex-runtime`: 版本兼容判定从精确匹配改为最低版本比较 + 降级警告；运行来源去除 App 优先、
  统一为显式配置 → PATH；运行来源诊断补充新发现的 `daemon`/`proxy` 子命令调研结论。
- `codex-interactive-approvals`: 审批决定集合补充 0.163.0 上新出现的决定类型（或明确记录过滤理由）；
  审批生命周期补充"决定类型不被支持时如何降级"的行为；审批卡片的展示补充"与 Claude 审批视觉
  一致、不得使用裸 JSON 转储"的要求。
- `codex-session-handoff`: 所有权锁补充"服务端非正常退出后的锁恢复路径"，减少人工删除磁盘目录的依赖。

## Impact

- 后端：`server/shared/codex-cli-path.ts`（版本比较逻辑 + 去除 App 优先）、`server/modules/codex-runtime/ownership.ts`
  （锁恢复路径）、`server/modules/codex-runtime/approvals.ts`（决定类型兼容）、
  `docs/codex-runtime-protocol.md`（协议实测记录更新）。
- 前端：`src/components/chat/view/subcomponents/PermissionRequestsBanner.tsx`（Codex 审批卡片
  布局改为复用 Claude 兜底结构）；可能涉及 `src/i18n/locales/{en,zh-CN}/chat.json`（补充摘要
  文案）。
- 文档：新增针对 0.163.0 的协议 schema 对照记录；记录 `daemon`/`proxy` 子命令调研结论。
- 依赖：本变更建立在未合并的 `feat/unify-codex-runtime-and-approvals` 分支之上，需要先有该分支
  的代码基线（`server/modules/codex-runtime/*`、`server/openai-codex.js` 的 app-server 实现）。
- 不涉及：不改变聊天/终端/认证统一解析可执行文件路径的既定方案；不复刻 ChatGPT.app 产品本身；
  不扩大审批范围到分支明确排除的场景（浏览器审批、Antigravity 接入等）。
