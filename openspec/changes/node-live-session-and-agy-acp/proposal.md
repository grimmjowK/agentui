## Why

工作流節點目前以 headless 方式執行，使用者只能在節點詳情看到最終文字輸出，無法即時看到工具調用與思考過程，也無法在執行中補充或修正指令；介入手段只有「停止整個工作流」。實際使用（`dm-pm` 工作流）中，節點要跑 tmux、clone、opsx-propose 等長任務，需要邊看邊糾正。

同時，Antigravity 的執行層仍是每輪 headless spawn（`agy --prompt`），沒有管道送入插話或回覆審批：插話不可用（`midTurnSteer: false`），需審批的工具被自動拒絕。既有提案 `antigravity-acp-interactive-approvals` 已設計改走 `agy acp`，但 27 項任務都未開工。節點要能「進入對話並插話」，三家可用 provider 中 Antigravity 必須先具備插話能力，因此兩件事合併在本 change 一起交付。

## What Changes

- **節點可進入對話頁（旁觀模式）**：
  - 節點詳情新增「打開對話」，跳到該節點的 provider 會話 `/session/<id>`；執行中與結束後都可以打開。
  - 聊天頁對「由工作流執行器持有的執行中會話」只旁觀：讀取已保存的訊息、接收之後的即時推送，**不**改送輸出（不呼叫 `runtime.reconnect`），工作流執行器照常收到完整事件。
  - 頁首顯示「工作流節點」標記與返回流程圖的連結。
- **節點輸出經 LoggingWriter 持久化**：節點的 runtime writer 改包一層 `LoggingWriter`，事件寫入 `session_messages` 並推送給擁有者的所有連線，聊天頁因此能看到完整過程與歷史。
- **工作流會話不進側邊欄**：新增持久化的「工作流會話」登記（sessionId → 多 Agent／執行／節點），側邊欄專案下的聊天列表、會話計數、封存列表與全文檢索一律排除這些會話；工作流的聊天頁只從節點詳情的「打開對話」進入。
- **執行中插話**：在節點會話的聊天頁送出訊息時走現有 `chat-steer`，不打斷這一輪；插話後的回覆計入節點輸出（節點輸出 = 這一輪結束時累積的完整助理文字）。
- **中斷後修正**：聊天頁可中斷該節點這一輪，再送出新訊息續接同一會話；節點維持「執行中」，以新一輪結束的結果作為節點結果。工作流層級的「停止」仍會結束整個節點。
- **Antigravity 改走 ACP**：吸收 `antigravity-acp-interactive-approvals` 的全部範圍（互動審批、權限模式、`session/resume` 續接、`session/cancel` 中斷、逾時、錯誤處理、執行中插話），該提案標記為被本 change 取代。**BREAKING**（內部）：移除 headless 執行路徑。
- **WebSocket 推送**：節點事件推送給該使用者的所有聊天連線（沿用 `sendToUser`），聊天頁依 `sessionId` 過濾，與一般會話相同。

## Capabilities

### New Capabilities
- `workflow-node-live-session`: 工作流節點的會話可在聊天頁旁觀、插話、中斷後修正，且不搶占工作流執行器的事件；節點輸出與最終狀態的判定規則。
- `antigravity-acp-runtime`: Antigravity 以 ACP 執行對話，包含互動審批、權限模式、續接、中斷、逾時與錯誤處理、執行中插話，以及接入全域待審批池（內容承接 `antigravity-acp-interactive-approvals` 的規格）。

### Modified Capabilities
<!-- multi-agent-workflow 尚在 multi-agent-workspace change 中、未歸檔到 openspec/specs/，以新能力描述節點層的新增行為。 -->

## Impact

- 後端：
  - `server/modules/multi-agent/services/agent-call.ts`、`workflow-runner.ts`：writer 改用 `LoggingWriter` 包裝並推送；支援「這一輪被使用者從聊天頁中斷後由新一輪接續」的完成判定；節點會話登記為「工作流持有」。
  - `server/modules/database`：新增 `workflow_sessions` 表與 repository；`sessions.db.ts` 的專案會話列表、計數、封存列表與 `getAllSessions`（全文檢索來源）排除登記中的會話。
  - `server/modules/websocket/services/chat-websocket.service.ts`：`check-session-status` 對工作流持有的會話只重播日誌、不呼叫 `runtime.reconnect`；`chat-command` 對執行中的節點會話改為插話或拒絕；`abort-session` 對節點會話標記為「使用者中斷、可續接」。
  - `server/antigravity-cli.js`（改寫為 ACP）、`modules/providers/list/antigravity/*`（`steer`、`getPendingApprovals`、`resolveApproval`、`mapAcpUpdate`）。
  - `shared/providers.ts`：Antigravity `midTurnSteer: true`、`permissionModes` 改為 `default`、`acceptEdits`、`plan`、`bypassPermissions`。
- 前端：節點詳情的「打開對話」；聊天頁的工作流節點標記；審批卡片依 `context.decisions` 分流（承接 ACP 提案 D4）。
- 依賴：agy CLI ≥ 1.5.3（本機 1.5.11）。
- 相關 change：`multi-agent-workspace`（前置）、`antigravity-acp-interactive-approvals`（被取代，實測與調研資料沿用）。
