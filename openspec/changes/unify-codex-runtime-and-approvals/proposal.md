# Proposal

## Why

Codex 聊天页与终端页使用不同的可执行文件选择逻辑，导致同机版本、功能和恢复行为不一致；聊天页虽然设置了审批策略，却没有接通请求、用户决定与继续执行的双向链路。用户切换到终端时还会遇到独立进程的陈旧历史与恢复失败后静默新建会话，无法可靠地继续同一段工作。

## What Changes

- 统一聊天、终端、认证与模型查询的 Codex 可执行文件、配置根目录和版本解析；提供运行来源及兼容性诊断。
- 将 Codex 聊天运行从单向 SDK `exec` 流迁移到经过目标版本实测的 app-server 协议，保持现有消息、会话 ID 和历史入口。
- 接通命令、文件修改及运行时支持的额外权限请求：展示审批卡片，等待用户选择，再将决定返回原请求；不支持的能力明确提示，不默认放宽权限。
- 完善审批的拒绝、取消、断线重连、超时和进程退出清理，防止跨用户或跨会话误审批。
- 为 agentui 管理的 Codex 会话增加聊天/终端独占写入与显式交接，切换后重新读取最新历史；移除 Codex 恢复失败后自动开启新会话的行为。
- 明确终端为同一 CLI、同一 thread 的另一交互入口，不承诺镜像整个官方 App 的功能或共用同一进程。

## Capabilities

### New Capabilities

- `codex-runtime`: Codex 运行来源、版本兼容、app-server 生命周期与规范化流式消息。
- `codex-interactive-approvals`: Codex 审批请求、授权范围、用户决定回传及生命周期。
- `codex-session-handoff`: Codex 聊天与终端之间的会话身份、写入互斥、历史刷新与失败处理。

### Modified Capabilities

无。现有 Gemini 权限规格和 slash-command-token 不变；已有聊天同步变更作为历史刷新基础，不重复定义其通用广播语义。

## Impact

- 后端：`server/openai-codex.js`、`server/shared/codex-cli-path.ts`、Codex provider、模型服务、聊天与 shell WebSocket 服务、共享消息类型及退出清理。
- 前端：聊天审批状态与卡片、审批回复路由、Shell 生命周期、聊天/终端切换入口、运行信息及中英文文案。
- 运行依赖：本机兼容的 Codex CLI/app-server；需要实测版本矩阵和协议 fixtures，不以 CLI 帮助输出作为兼容结论。
- 保留现有 Codex 历史与认证，不复制凭据、不升级用户 CLI、不修改全局默认权限；Antigravity 接入及其他 provider 的权限行为不在本次范围。
