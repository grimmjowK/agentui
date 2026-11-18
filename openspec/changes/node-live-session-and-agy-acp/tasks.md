## 1. Antigravity ACP：實測與錄製（以 agy 1.5.11 為準）

- [ ] 1.0 重新驗證 `antigravity-acp-interactive-approvals/research.md` 中 agy acp 的已知問題（skills 不出現、`authenticate` 逾時、串流卡住），結果補進該 research.md
- [ ] 1.1 錄製協議 fixture 到 `docs/fixtures/antigravity/acp-*.jsonl`：允許、拒絕、審批中 `session/cancel`、`session/resume` 續接、工具執行中插話、審批等待中插話；確認 `tool_call_update` 完成時的結果形狀與被拒後的行為
- [ ] 1.2 實測模型設定方式（`session/set_model`／`configOptions`／`--model`）、`--dangerously-skip-permissions` 是否有效、未登入時的錯誤形狀
- [ ] 1.3 把 1.1–1.2 結論寫進本 change design.md 的 Open Questions，必要時修正 D7

## 2. Antigravity ACP：協議與事件映射

- [ ] 2.1 Antigravity 模組內新增 ACP JSON-RPC over stdio 連線類別（請求逾時、行程退出時 reject 未完成請求、stderr 只當診斷、`protocolVersion` 不是 1 時報錯）；以假行程寫單元測試
- [ ] 2.2 `antigravity-tool-mapper.ts` 新增 `mapAcpUpdate`（ACP design D3 對照表），工具名稱與參數沿用 `mapAgyTool`；以 1.1 fixture 寫測試

## 3. Antigravity ACP：審批池

- [ ] 3.1 審批池：新增（綁定 userId／sessionId／執行個體、`context.decisions`、`context.expiresAt`）、決定（嚴格比對）、逾時拒絕並送 `permission_cancelled`、依執行個體清除、依使用者列出
- [ ] 3.2 審批池測試：非發起者被拒、缺少 userId 被拒、決定不在選項內被拒、逾時回覆 deny、清除時回覆已取消、列出只含該使用者

## 4. Antigravity ACP：執行層替換

- [ ] 4.1 改寫 `server/antigravity-cli.js`：每輪 `agy acp` → `initialize` → `session/new`／`session/resume` → `session/set_mode` → 模型 → `session/prompt`；`session/update` 經 `mapAcpUpdate` 轉送；所有 prompt 返回後送一次 `complete`
- [ ] 4.2 中斷：`session/cancel` → 未決審批回覆已取消 → 等待 `cancelled`，7 秒未返回就結束行程；`abort` 回傳 `emitsTerminal: true`
- [ ] 4.3 錯誤處理：未登入、初始化失敗、行程意外退出、JSON-RPC 錯誤時送出 `error` 與結束事件、清除待審批；移除 `findPermissionDeniedNotice` 及其測試
- [ ] 4.4 插話（ACP D8）：計算未返回的 prompt，全部返回才收尾；`steerAntigravitySession` 收尾後回覆 `not_running`；以插話 fixture 寫測試
- [ ] 4.5 writer 支援 `reconnect`（一般聊天斷線重連，design D7 補充 1）；`antigravity-runtime.provider.ts` 接上 `steer`、`getPendingApprovals`、`resolveApproval`

## 5. Antigravity ACP：WebSocket、前端與設定

- [ ] 5.1 `chat-websocket.service.ts` 新增 `permission-decision { provider, requestId, sessionId, decision }` 分派到 `runtime.resolveApproval`；測試
- [ ] 5.2 前端審批卡片與送出依 `context.decisions` 判斷，Antigravity 送 `permission-decision`，Codex 維持原訊息；多 Agent 節點詳情的工具審批（`NodeToolApprovals`）同步支援；補 i18n
- [ ] 5.3 `shared/providers.ts`：Antigravity `midTurnSteer: true`、`permissionModes` 改為 `default`、`acceptEdits`、`plan`、`bypassPermissions`；多 Agent 成員預設權限表同步檢查
- [ ] 5.4 `antigravity-acp-interactive-approvals/proposal.md` 頂部標註「已被 node-live-session-and-agy-acp 取代」

## 6. 節點會話：持久化、推送與側邊欄排除

- [ ] 6.1 `AgentCall` 的 writer 改為 `LoggingWriter(inner = FanoutWriter)`：FanoutWriter 同時交給 `AgentCall.handle` 與 `sendToUser`；以 `recordUserMessage` 記錄節點實際提示
- [ ] 6.2 工作流持有會話登記表（sessionId → runId／nodeId／userId），節點取得 sessionId 時登記、結束時移除；`isWorkflowSession(sessionId)` 供 WebSocket 使用
- [ ] 6.3 新增 `workflow_sessions` 表（`session_id` PK、multi_agent_id、run_id、node_id、user_id、created_at）與 repository；節點取得 sessionId 時先寫入；刪除多 Agent 時級聯刪除
- [ ] 6.4 `sessions.db.ts` 的 `getSessionsByProjectPath`、`getSessionsByProjectPathPage`、`countSessionsByProjectPath`、`getArchivedSessions`、`getAllSessions` 排除 `workflow_sessions`；`getSessionById` 與 `getSessionsByProjectPathIncludingArchived` 不排除
- [ ] 6.5 測試：節點事件寫入 `session_messages`、推送給使用者、執行中登記與移除；工作流會話不出現在專案會話列表／計數／封存／全文檢索來源，同專案一般會話不受影響

## 7. 節點會話：旁觀不搶占

- [ ] 7.1 `check-session-status` 對登記中的會話：不 `updateWebSocket`、不 `runtime.reconnect`，改以暫時 LoggingWriter `replayAfterSeq`（含串流段落）；回覆 `session-status` 帶 `workflow { multiAgentId, runId, nodeId }`
- [ ] 7.2 測試：旁觀後執行器仍收到全部事件；一般會話的重連行為不變

## 8. 節點會話：插話、中斷後修正、防呆

- [ ] 8.1 `chat-steer` 對節點會話：沿用 `runtime.steer`，使用者訊息記入節點的 LoggingWriter；節點輸出包含插話後的回覆（測試）
- [ ] 8.2 新狀態 `waiting_input`：`abort-session` 對節點會話標記使用者中斷；`AgentCall` 以 aborted 結束且為使用者中斷時，節點進入 `waiting_input` 並掛起 resolver
- [ ] 8.3 `chat-command` 對 `waiting_input` 的節點會話：交由執行器以同一 sessionId 續接新一輪，輸出累加；對執行中（非等待）的節點會話拒絕並提示改用插話
- [ ] 8.4 畫布操作「以目前輸出完成」「標記失敗」的 API 與 runner 方法；工作流停止結束 `waiting_input`；`markInterrupted` 處理 `waiting_input`
- [ ] 8.5 runner 測試：中斷→續接→成功、中斷→以目前輸出完成、中斷→工作流停止、執行中一般送出被拒

## 9. 前端

- [ ] 9.1 節點詳情新增「打開對話」（有 sessionId 時），導向 `/session/<id>`；畫布與節點卡片顯示 `waiting_input`（含「以目前輸出完成」「標記失敗」）
- [ ] 9.2 `useProjectsState`：URL 的 sessionId 不在任何專案時，以 `GET /api/providers/sessions/:id` 取得 provider 與 project_path 組出臨時專案
- [ ] 9.3 聊天頁收到 `session-status.workflow` 時顯示「工作流節點：<標題>」與返回流程圖連結
- [ ] 9.4 i18n（zh-CN、en）

## 10. 驗收（瀏覽器實測，任一不通過即不算完成）

- [ ] 10.1 承接 ACP 提案驗收 6.1–6.9：Antigravity 審批允許／拒絕／重新整理／切換會話／停止／逾時／續接／權限模式／插話；Codex、Claude 審批迴歸
- [ ] 10.2 Claude、Codex、Antigravity 節點各一次：執行中打開對話看到工具調用與串流，重新整理後補齊，節點照常完成且輸出完整
- [ ] 10.3 節點執行中在聊天頁插話（三家各一次），模型採納，節點輸出包含插話後回覆，下游收到
- [ ] 10.4 節點聊天頁中斷 → 畫布顯示等待指示 → 聊天頁送出新指示 → 節點成功、下游執行；另測「以目前輸出完成」與工作流停止
- [ ] 10.5 專屬目錄的工作流，節點對話以正確 provider 與工作目錄載入
- [ ] 10.5a 工作目錄設為一般專案（如 `dm_pm`）執行後：側邊欄該專案的會話列表、計數、⌘K 搜尋都看不到節點會話；重啟服務後仍看不到；從節點「打開對話」可進入
- [ ] 10.6 `npm run typecheck`、`npm run lint`（0 錯誤）、`npm test`、`npm run build` 全部通過；更新 `server/SERVER.md`、`server/modules/MODULES.md`、`server/modules/providers/README.md`
