## Context

**工作流節點現況**（`multi-agent-workspace`）：`AgentCall` 以自訂 writer 呼叫 `runtime.start`，事件只在記憶體累積成節點輸出，不寫入 `session_messages`，也不推給聊天連線。節點會話的 sessionId 已記在 `NodeRunStatus.sessionId`。工作目錄可設定，provider 會話會被同步器索引（專屬目錄不出現在側邊欄專案列表）。

**聊天頁打開執行中會話的現況**：前端送 `check-session-status`，後端：
1. 若該 sessionId 有已登記的 `LoggingWriter`：`registered.updateWebSocket(writer.ws)`（把該 writer 的輸出改送到這個連線），再 `replayAfterSeq`。
2. 呼叫 `runtime.reconnect(sessionId, writer)`：Claude 換掉 SDK 會話內的 raw ws；Codex 換掉 `state.writer`；Antigravity 換掉 reconnectable writer。

這兩步都是「改送」——原設計用於同一使用者斷線重連，對工作流節點則會把事件從執行器搶走。

**插話現況**：Claude（`steerClaudeSDKSession`，推入 SDK input）、Codex（`turn/steer`）可用；Antigravity headless 不可用。三家 `steer` 都以 `writer.userId` 判定擁有者，節點會話的擁有者就是工作流的使用者，天然相容。

**Antigravity ACP**：`antigravity-acp-interactive-approvals` 已完成設計（D1–D8）與 2026-11-05/09 的實測（agy 1.5.0/1.5.3）；本機目前 agy 1.5.11。本 change 直接承接其設計，下文以「ACP D1–D8」引用，只寫差異與補充。

## Goals / Non-Goals

**Goals:**
- 聊天頁可以打開任一工作流節點的會話：執行中即時看到工具調用、思考、串流；結束後看到完整歷史。
- 旁觀不影響執行器：打開、關閉、重新整理聊天頁，執行器都收到完整事件。
- 在節點會話中插話（三家 provider）、中斷後送新訊息修正，以及在已結束節點聊天頁繼續追問後自動續接該節點並重跑下游（含人工確認退回重做）。
- Antigravity 改走 ACP，具備互動審批與插話。

**Non-Goals:**
- 迴圈節點、按工單展開（使用者已決定暫緩）。
- 聊天室成員會話的旁觀（成員是短回覆、有字數上限，第一版不做；架構相同，之後可沿用）。
- 不分 provider 的 ACP 執行層（ACP 研究建議，仍不在範圍）。

## Decisions

### D1. 節點 writer 改為「LoggingWriter + 使用者廣播」，執行器以 tap 收事件

```
runtime.start(prompt, opts, loggingWriter)
                 │
         LoggingWriter(inner = FanoutWriter)      ← 寫 session_messages、指派 seq、登記 activeWriters
                 │
         FanoutWriter.send(msg)
            ├─ AgentCall.handle(msg)              ← 執行器：累積輸出、進度、審批狀態（原邏輯不變）
            └─ sendToUser(userId, msg)            ← 該使用者所有聊天連線；前端依 sessionId 過濾
```

- `LoggingWriter` 已處理 seq、持久化、串流段落（`streamingText`）與 `replayAfterSeq`，直接沿用，不另寫一套節點訊息表。
- 推送給「使用者的所有連線」而不是「打開該會話的連線」：沿用一般聊天的做法（`useChatRealtimeHandlers` 已依 sessionId 過濾非目前會話的事件），不需要訂閱機制。
- 首則使用者訊息：以 `recordUserMessage` 記錄節點的實際提示（含上游輸出），聊天頁打開時看得到節點收到了什麼。

替代方案：聊天頁輪詢節點輸出 → 看不到工具調用與審批，且延遲高，否決。

### D2. 工作流會話：持久化登記 + `check-session-status` 不改送

**兩層登記，用途不同：**

| | 存放 | 生命週期 | 用途 |
| --- | --- | --- | --- |
| `workflow_sessions` 表 | SQLite：`session_id PK, multi_agent_id, run_id, node_id, user_id, created_at` | 節點取得 sessionId 時寫入，永久保留；刪除多 Agent 時級聯刪除 | 側邊欄排除、聊天頁顯示節點標記與返回連結 |
| 執行中登記（記憶體） | `Map<sessionId, { runId, nodeId, userId }>` | 節點執行中（含 `waiting_input`）；結束即移除 | 旁觀不改送（下方）、D4／D5 的送出判斷 |

- 寫入時機：`AgentCall` 收到 sessionId（`session_created` 或首個帶 sessionId 的事件）時，**先**寫 `workflow_sessions`，再讓事件繼續流動；同步器在之後才會看到 transcript，所以會話第一次被索引時已在排除名單。
- `check-session-status` 遇到**執行中登記**的 sessionId：
  - **不** `registered.updateWebSocket(...)`、**不** `runtime.reconnect(...)`。
  - 以一個暫時的 `LoggingWriter(inner = 這個連線)` 執行 `replayAfterSeq(afterSeq)`，補齊漏掉的訊息與目前的串流段落（現有暫時 writer 路徑已有，只是條件改為「登記中也走這條」）。
  - 回覆 `session-status { isProcessing: true, workflow: { multiAgentId, runId, nodeId } }`，前端據此顯示節點標記與「返回流程圖」。
- `runtime.reconnect` 本身不改：一般聊天斷線重連仍需要它。

這就是「進入正在執行的 session，而不是搶占」：輸出一直由執行器的 FanoutWriter 送出，聊天頁只是多一個接收者。

### D2.1 側邊欄與檢索排除工作流會話

- `sessions.db.ts` 的 `getSessionsByProjectPath`、`getSessionsByProjectPathPage`、`countSessionsByProjectPath`、`getArchivedSessions`、`getAllSessions` 一律加上 `AND session_id NOT IN (SELECT session_id FROM workflow_sessions)`。
  - 排除範圍擴大到多 Agent 擁有的所有會話：除了 `workflow_sessions`，也包括建立器會話（`multi_agents.builder_session_json`）與聊天室成員會話（`member_sessions_json`）。建立器在工作目錄設為一般專案時同樣會出現在側邊欄，從多 Agent 頁面進入即可。
  - 涵蓋側邊欄專案下的會話列表與計數、封存視圖、全文檢索（⌘K，來源是 `getAllSessions`）、`@session` 引用的候選。
  - `getSessionById`、`getSessionsByProjectPathIncludingArchived`（刪除專案時清理檔案）**不**排除：前者是聊天頁按 id 載入所需，後者需要看到全部檔案。
- 專案列表本身不受影響：工作流會話所在的專案（例如 `dm_pm`）如果還有一般會話，照常顯示；只是工作流產生的會話不在其下。工作流使用專屬目錄時，該目錄原本就已被排除。
- 會話被同步器重新掃描、改名或封存，都不影響排除：判斷依據是 `workflow_sessions` 有沒有這個 id，與 sessions 表的欄位無關。
- 聊天頁進入：只從節點詳情的「打開對話」；直接輸入 `/session/<id>` 也能打開（由 `getSessionById` 載入），但側邊欄不會高亮任何項目。

替代方案：在 `sessions` 表加 `origin` 欄位 → 同步器以 upsert 寫入 sessions，可能早於或覆蓋節點寫入的標記，產生競態；獨立表只由節點寫入，無此問題，否決。

### D3. 插話：沿用 `chat-steer`，回覆計入節點輸出

- 前端：節點會話執行中時，輸入框的送出走現有「生成中送出 → 佇列 → 立即引導」流程（`chat-queued-steer-composer`），不新增 UI。
- 後端 `chat-steer`：`runtime.steer(sessionId, userId, text)` 照常；使用者訊息以 `getLoggingWriterForSession(sessionId)`（即節點的 LoggingWriter）`recordUserMessage`，所以會出現在節點的訊息紀錄。
- 節點輸出：`AgentCall` 原本就累積「這一輪所有助理文字」，插話後模型的回覆自然計入。最終輸出 = 這一輪結束時的完整累積文字。

### D4. 中斷後修正：節點不失敗，等新一輪結束

情境：使用者在聊天頁按停止（`abort-session`），修改指示後再送出。

- `abort-session` 對工作流持有的會話：照常呼叫 `runtime.abort`，同時把該節點標記 `userInterrupted = true`，節點狀態改為 `waiting_input`（新狀態，畫布顯示「已中斷，等待你的指示」）。
- `AgentCall.run()` 收到 aborted 結束時：若 `userInterrupted`，不判定失敗，而是掛起等待（與人工確認節點同一模式：resolver 掛在 ActiveRun 上）。
- 使用者在聊天頁送出新訊息（`chat-command`，sessionId = 節點會話）：
  - 後端偵測為工作流持有、且節點在 `waiting_input`：不走一般啟動路徑，交由執行器以同一 sessionId 續接（`runtime.start(text, { sessionId, resume: true, ... }, 同一個 FanoutWriter 新包的 LoggingWriter)`）。
  - 新一輪結束後，節點依結果判定成功或失敗；輸出採用最新一輪最後一個非空回覆段落（過濾工具呼叫前的過程文字）。
- `waiting_input` 也提供兩個畫布操作：「以目前輸出完成」（把已累積的文字當作成功輸出，繼續下游）、「標記失敗」。
- 工作流層級的「停止」：一律結束節點（失敗、stopped），包括 `waiting_input` 中的節點。
- `waiting_input` 計入逾時？不計，與人工確認相同，由使用者決定。

替代方案：中斷即失敗、要求使用者重跑整個工作流 → 長流程中代價過高，否決。

### D5. 節點會話的 `chat-command` 防呆

節點會話在執行中（非 `waiting_input`）收到 `chat-command`：拒絕並回覆 `task_notification`（「節點執行中，請使用插話」）。前端正常情況下會走插話佇列，不會觸發；這是防多分頁競態。

### D6. 前端入口與標記

- 節點詳情：節點有 `sessionId` 時顯示「打開對話」，導向 `/session/<sessionId>`；聊天頁需要專案上下文：以工作流的 `workspacePath` 對應的 projectId（`GET /api/multi-agent/:id` 已回傳，沿用 BuilderView 的組法）。
- `useProjectsState` 遇到 URL 的 sessionId 不在任何專案（工作流會話一律被排除，見 D2.1）：以 `GET /api/providers/sessions/:id` 取得 provider 與 project_path 組出臨時專案（目前只靠 localStorage 猜 provider，節點會話需要準確的 provider）。
- 聊天頁頭部：收到 `session-status.workflow` 時顯示「工作流節點：<節點標題>」與返回流程圖的連結。

### D7. Antigravity：承接 ACP D1–D8，差異如下

- **整體沿用**：每輪一個 `agy acp` 行程（ACP D1）、JSON-RPC 類別（D2）、`mapAcpUpdate`（D3）、審批池與 `permission-decision`（D4）、逾時與中斷（D5）、權限模式（D6）、模型與登入（D7）、插話計數（D8）。
- **補充 1：reconnect**：ACP 執行層的 writer 也要支援 `reconnect`（一般聊天斷線重連），行為與現有 `createReconnectableWriter` 相同；工作流節點依 D2 不會呼叫它。
- **補充 2：中斷後續接（D4）**：ACP 下續接用 `session/resume`，與一般續接相同，不需特例。
- **補充 3：版本與實測**：以 agy 1.5.11 重錄，結論見下方「實測結論」，其中三點修正 ACP 提案：權限模式多一個 `auto`；`bypassPermissions` 改用 `--dangerously-skip-permissions` 旗標；審批等待中不能插話（`steer` 回 `waiting_approval`）。
- ACP 提案標記為「已被 `node-live-session-and-agy-acp` 取代」，research.md 與 fixture 計畫沿用。

## Risks / Trade-offs

- [節點事件改走 LoggingWriter 後，`session_messages` 會多出工作流節點的訊息] → 這正是需要的；保留期與清理沿用 `session-message-log-cleanup`，執行中會話不清理。
- [推送給使用者所有連線，多分頁時每頁都收到節點事件] → 與一般聊天相同，前端依 sessionId 過濾；量級是單一使用者的節點數，可接受。
- [`waiting_input` 讓節點無限期掛起] → 畫布明確顯示並提供「以目前輸出完成／標記失敗」；工作流停止會結束它；服務重啟時視為中斷（沿用 `markInterrupted`）。
- [ACP 是較新的協議，agy 升級可能改欄位] → 沿用 ACP 提案的 fixture 測試策略；`initialize` 版本不符時明確報錯。
- [`NOT IN (SELECT …)` 增加列表查詢成本] → `workflow_sessions.session_id` 為主鍵，量級是節點執行次數，對側邊欄分頁查詢影響可忽略。
- [使用者想在側邊欄找工作流會話卻找不到] → 刻意設計：入口在流程圖的節點詳情；執行記錄下拉可找回歷史 run 的節點。
- [前端同時存在「一般會話」與「工作流持有會話」兩種語意] → 差異集中在後端 D2/D2.1/D4/D5 幾處判斷；前端只多一個標記與一個入口。
- [Antigravity 替換執行層影響一般聊天] → ACP 提案的驗收清單（6.1–6.10）全部保留為本 change 的驗收項。

## Migration Plan

- 先完成 Antigravity ACP（可獨立上線、一般聊天立即受益），再做節點旁觀與插話。兩段各自可回滾。
- 已存在的工作流執行紀錄不需遷移；舊 run 的節點沒有 session_messages，打開對話時只看得到 provider 歷史（同步器讀取原生 transcript）。
- `antigravity-acp-interactive-approvals` 不歸檔，於 proposal 頂部標註被取代，本 change 歸檔時一併移除。

## 實測結論（agy 1.5.11，2026-11-18，fixture：`docs/fixtures/antigravity/acp-*.jsonl`）

| 項目 | 結論 | 對設計的影響 |
| --- | --- | --- |
| `initialize` | `protocolVersion: 1`；`agentInfo.version: 1.5.11`；`sessionCapabilities` 含 `resume/close/load/list/additionalDirectories` | 照 ACP D1 |
| 模式 | `default`、`accept-edits`、**`auto`**（新）、`plan`；`session/set_mode` 回 `{}` 並推 `current_mode_update` | Antigravity `permissionModes` 增加 `auto` |
| 模型 | `session/new` 回 `models.availableModels`（`gemini-4-argon-low` 等完整 id，與現有模型清單相同）；`session/set_model { modelId }` 回 `{}` | 用 `session/set_model`，不用 `--model` |
| 審批請求 | `session/request_permission` 的 JSON-RPC **id 是字串**（`"1"`）；`options: allow(allow_once) / deny(reject_once)` | 連線類別的請求 id 型別不可假設數字 |
| 允許後 | `tool_call_update` `pending → in_progress → completed`；結果在 `rawOutput.output`（含 `Command exited with code N` 前綴）與 `content[].content.text`，另有 `rawOutput.exit_code` | `tool_result.content` 取 `content` 文字，`isError` 依 `status` |
| 拒絕後 | `tool_call_update` `failed`、輸出空字串；**模型不再回覆**，`session/prompt` 以 `end_turn` 返回 | 被拒工具卡片顯示錯誤（內容補「已拒絕」）；這一輪正常結束 |
| 審批中 `session/cancel` | 回覆未決審批 `cancelled` 後，工具 `failed`，prompt 以 `stopReason: cancelled` 返回 | 照 ACP D5 |
| `session/resume` | 不重播歷史（只有 `available_commands_update` 等少量 update），續接後模型記得前文 | 照 ACP D1 |
| `--dangerously-skip-permissions` | `agy acp` 接受；不再發出 `session/request_permission` | `bypassPermissions` 改傳旗標，不由客戶端代答（ACP D6 的優先方案） |
| 工具執行中插話 | 第一個 prompt **立刻**以 `{stopReason: end_turn}`（無 usage）返回；工具照常跑完；模型最後產生一則回覆並遵循插話；第二個 prompt 最後返回（帶 usage） | 照 ACP D8 的計數收尾 |
| **審批等待中插話** | **被拒**：`-32603 "the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again"` | `steer` 遇到有未決審批時回覆 `waiting_approval`，不送 prompt；前端把訊息留在佇列，審批後可再「立即引導」 |
| 未登入 | `initialize` 成功，`session/new`／`session/prompt` 回 `-32000 "Authentication required"` | 映射為「請先在終端執行 `agy` 完成登入」 |
| 已知問題（research.md） | skills：`available_commands_update` 只列內建指令，**不含** `~/.agents/skills` 等自訂 skills（仍存在）；串流與 `authenticate` 逾時在本次未重現 | 斜線指令仍沿用現有 skills 掃描（provider 的 skills facet），不依賴 ACP 指令清單 |

## Open Questions

- `waiting_input` 中使用者改從聊天頁送出的是「新的一輪」，Claude 會在 transcript 留下中斷標記；歷史顯示是否需要特別處理，實作時以實際畫面判斷。
