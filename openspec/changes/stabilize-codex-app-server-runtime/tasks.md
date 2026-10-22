## 1. 基线准备

- [x] 1.1 基于 `feat/unify-codex-runtime-and-approvals` 创建本变更的工作分支，确认
      `server/modules/codex-runtime/*`、`server/openai-codex.js`、`server/shared/codex-cli-path.ts`
      已存在且为分支版本（而非 `main`）
- [x] 1.2 用本机已装的多个 Codex 版本（homebrew `0.163.0`、ChatGPT.app `0.155.0-alpha.9.2`）
      分别记录 `codex --version` 原始输出，作为后续版本比较逻辑的测试样本

## 2. 版本门禁（D1）

- [x] 2.1 在 `server/shared/codex-cli-path.ts` 中实现版本号解析函数：从
      `codex-cli X.Y.Z[-prerelease]` 格式中提取可比较的 `(major, minor, patch)`，解析失败时
      返回明确的"不支持"结果而非抛异常或当作兼容版本处理
- [x] 2.2 将 `getCodexRuntimeInfo()` 的 `capabilities.status` 判定从精确字符串比较改为
      "解析后的版本号 >= 最低已验证版本"的比较；版本号无法解析时 `status` 为 `'unsupported'`
      （新状态，与现有 `'protocol-tested'`/`'unverified'` 区分）
- [x] 2.3 在 `server/openai-codex.js` 的 `queryCodex()` 中：`'unsupported'` 时仍然
      `throw`（保持现有拒绝行为）；`'unverified'`（版本低于最低已验证但可解析）时不再
      `throw`，继续尝试建立 app-server 连接，并通过 `task_notification`
      （`status: 'warning'`）告知用户该版本未完整验证
- [x] 2.4 为 2.1-2.3 编写/更新单元测试（`server/shared/codex-cli-path.test.ts`），覆盖：
      已验证版本、低于最低版本但可解析、版本号格式无法解析、平台不支持四种场景
- [ ] 2.5 在本机用 homebrew `0.163.0` 和 ChatGPT.app `0.155.0-alpha.9.2` 分别手动验证
      聊天能正常进入 app-server 协议（不再被版本门禁拦截）【需用户手动跑应用验证，见收尾说明】

## 2b. 运行来源去除 App 优先（D6）

- [x] 2b.1 在 `server/shared/codex-cli-path.ts` 中删除 `MAC_APP_CODEX_PATHS` 与 darwin App
      优先分支，解析顺序改为 `CODEX_CLI_PATH` → PATH 的 `codex`；PATH 找不到时报错提示安装
      CLI 或设置 `CODEX_CLI_PATH`，不退回 App 内置版本
- [x] 2b.2 `getCodexRuntimeInfo().source` 简化为 `configured | path`（去掉 `app`，无消费者）
- [x] 2b.3 更新 `codex-cli-path.test.ts`：存在 App 风格二进制时不被自动选中、显式 `CODEX_CLI_PATH`
      指向 App 仍可用、PATH 无 codex 时报错
- [ ] 2b.4 在那台出现 account/read 超时的 Mac 上验证：去掉 App 优先后，agentui 与终端
      `which codex` 用的是同一个二进制，历史会话切 Shell 能正常 resume，不再超时
      【需用户手动跑应用验证】

## 2c. paginated thread resume 规避（D7）

- [x] 2c.1 `queryCodex` 的 `thread/resume` 加 `excludeTurns: true`（metadata-only），避开
      paginated thread 全量 hydration 触发的 `paginated_threads is not supported yet`
- [x] 2c.2 `prepareCodexTerminalThread` 的 `thread/read` 保持 metadata-only，加注释禁止将来
      误加 `includeTurns:true`
- [x] 2c.3 `codexTerminalFailure` 识别 `paginated_threads is not supported yet` /
      `paginated threads require thread/items/list` 报错，给出可读诊断（会话为分页格式、
      终端暂不能恢复、聊天仍可用）
- [x] 2c.4 为 2c.3 补测试（`terminal-failure.test.ts`）
- [ ] 2c.5 在那台 Mac 上验证：聊天能 resume 之前报 paginated 错误的会话；终端遇到同类会话时
      显示可读诊断而非原始报错【需用户手动跑应用验证；终端原生 TUI 的 resume 受限于 CLI
      尚未实现分页读取，agentui 无法替 TUI 注入 excludeTurns】

## 3. 审批决定兼容性（D3）

- [x] 3.1 用本机 `codex app-server generate-json-schema` 重新生成协议 schema，对比分支
      `docs/codex-runtime-protocol.md` 中记录的审批决定类型，列出新增的决定类型及其结构
- [x] 3.2 在 `server/modules/codex-runtime/approvals.ts` 的 `CodexApprovals.add()` 中补充：
      当 `availableDecisions` 经过受支持范围过滤后为空数组时，回退为 `['decline']`，并记录
      一条诊断日志（包含原始候选决定列表）
- [x] 3.3 为 3.2 编写/更新单元测试（`server/modules/codex-runtime/approvals.test.ts`），覆盖：
      正常候选集合、候选集合被过滤后非空、候选集合被过滤后为空三种场景
- [x] 3.4 将 3.1 的 schema 对比结论追加到 `docs/codex-runtime-protocol.md`（不覆盖原有
      0.155-alpha 实测记录），标注验证版本、日期、新增决定类型及是否纳入支持范围的理由

## 4. 审批卡片视觉（D5）

- [x] 4.1 在 `src/components/chat/view/subcomponents/PermissionRequestsBanner.tsx` 的
      `request.provider === 'codex'` 分支中，把裸 `<pre>{JSON.stringify(...)}</pre>` 替换为
      复用 Claude 兜底卡片的结构（`ShieldAlertIcon` + 标题 + 摘要主体 + 可折叠详情）
- [x] 4.2 命令审批（`toolName` 为 `item/commandExecution/requestApproval`）主体展示
      `input.command`、`input.cwd`，存在 `input.reason` 时展示原因；完整 `input` 收入
      "View request details" 可折叠区
- [x] 4.3 文件审批（`toolName` 为 `item/fileChange/requestApproval`）主体展示涉及的文件
      或变更摘要；完整 `input` 收入可折叠区
- [x] 4.4 未知类型的 Codex 请求沿用统一卡片外壳，仅展示标题 + 可折叠完整内容，不退化为裸
      `<pre>`
- [x] 4.5 保留分支已有的 Codex 专属逻辑：过期倒计时（`context.expiresAt` 每秒 tick）、
      `submitted` 去重、按 `context.decisions` 动态渲染决定按钮；确认这些在新布局下行为不变
- [x] 4.6 若摘要需要新文案，补充 `src/i18n/locales/en/chat.json` 与
      `src/i18n/locales/zh-CN/chat.json` 对应键
- [ ] 4.7 在本机手动确认 Codex 命令审批卡片与 Claude 命令审批卡片视觉一致（卡片外壳、图标、
      标题、可折叠详情排版），不再是裸 JSON【需用户手动跑应用验证，见收尾说明】

## 5. 异常锁诊断与显式恢复（D2）

- [x] 5.1 在 `server/modules/codex-runtime/ownership.ts` 的锁记录（`owner.json`）中补充
      `claimedAt` 时间戳字段
- [x] 5.2 实现一个只读诊断函数：输入锁目录，输出持有方类型、`claimedAt`、距今时长，以及
      服务端进程和子进程各自的双重身份校验结论（已确认退出/已确认存活/无法确认）
- [x] 5.3 为诊断函数暴露一个可通过 CLI 脚本或管理端点调用的入口（不在聊天/终端常规 UI
      路径上暴露）— `scripts/codex-lock-admin.ts`
- [x] 5.4 实现显式强制释放操作：仅当锁的双重身份校验结论为"无法确认"且超过可配置时限时
      可调用；执行释放前必须重新核对一次双重身份校验，若发现持有方已能确认存活则中止并
      报告冲突
- [x] 5.5 确认现有的"双方均明确已退出"自动回收流程（`recovering` 目录 + 世代核对 + 原子
      rename）不受本次改动影响，补充回归测试验证该路径行为不变
- [x] 5.6 为 5.1-5.4 编写/更新单元测试（`server/modules/codex-runtime/ownership.test.ts`），
      覆盖：诊断只读查询、超时后显式释放成功、释放前发现持有方恢复而中止三种场景

## 6. 官方共享机制调研（D4）

- [x] 6.1 在本机运行 `codex app-server daemon --help` 与 `codex app-server proxy --help`，
      记录其参数、用途描述
- [x] 6.2 若 `daemon`/`proxy` 的描述显示其提供共享后台进程或连接代理能力，进一步判断是否
      内建单写者/并发互斥语义（可通过查阅对应的协议 schema 或实际启动测试确认）
- [x] 6.3 将调研结论（复用建议、不复用理由、或需要进一步验证的开放问题）写入
      `docs/codex-runtime-protocol.md`（新增 daemon/proxy 调研章节）

## 7. 验证与收尾

- [x] 7.1 运行 `npm run typecheck`，确认改动的 `.ts` 文件无类型错误（前后端 tsconfig 均通过）
- [x] 7.2 运行 `npm run lint`，确认无新增 lint 错误（改动文件 0 errors；`openai-codex.js` 的
      import-order 警告为改动前已存在，`scripts/` 不在 eslint 配置范围）
- [x] 7.3 运行受影响模块的测试套件（`codex-cli-path.test.ts`、`approvals.test.ts`、
      `ownership.test.ts`、`app-server.test.ts`），全部通过（16 tests pass）；`npm run build` 通过
- [ ] 7.4 手动场景回归：聊天在两个不同 Codex 版本上均能发起对话并完成一轮审批；终端能
      恢复聊天创建的会话，反之亦然；人为触发一次服务端非正常退出（如 `kill -9` 对应子
      进程）后，确认诊断操作能看到正确的"无法确认"或"已确认退出"结论【需用户手动跑应用验证】
- [x] 7.5 更新 `openspec/changes/unify-codex-runtime-and-approvals/` 下相关文档交叉引用
      本变更（如适用），避免审阅者混淆两个变更的范围边界
