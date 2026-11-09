## Context

Antigravity 目前的執行層（`server/antigravity-cli.js`）每輪啟動 `agy --prompt … --output-format stream-json`，stdin 為 `ignore`。預設模式下需要審批的工具會被自動拒絕，結果仍是 `SUCCESS`，頁面無從得知（現有臨時修正只是把 stderr 的說明轉成警告）。

agy 1.5.0 的 `agy acp` 實測結果（2026-11-05，本機 `/tmp/agy-acp/probe*.mjs`）：

- `initialize`（`protocolVersion: 1`）回報 `loadSession`、`sessionCapabilities.{resume, close, load, list}`、`authMethods`（Google / Gemini Enterprise 登入）。
- `session/new { cwd, mcpServers: [] }` 回報 `sessionId`、`models.availableModels / currentModelId`、`modes.availableModes`：`default`、`accept-edits`、`plan`（**沒有**跳過權限的模式）。
- `session/prompt` 期間以 `session/update` 通知串流：`user_message_chunk`、`session_info_update`（標題）、`tool_call`（`name`、`args` 與 headless `step_update` 相同，例如 `run_command` / `CommandLine`；另有 `kind`、`title`、`rawInput`、`status`）、`tool_call_update`（`pending` → `in_progress` → `completed`）、`agent_message_chunk`、`available_commands_update`。回應為 `{ stopReason, usage }`。
- 工具需要審批時，agent 發出 `session/request_permission { sessionId, toolCall, options: [{optionId:'allow', kind:'allow_once'}, {optionId:'deny', kind:'reject_once'}] }`，客戶端回覆 `{ outcome: { outcome: 'selected', optionId } }` 後才繼續。
- `session/resume` 續接舊會話且**不重播歷史**；`session/load` 會把整段歷史以 `session/update` 重播一次。
- `session/set_mode { sessionId, modeId }` 可用。
- 執行中再送一個 `session/prompt`（2026-11-09，agy 1.5.3 實測）：第一個 `session/prompt` 立刻以 `end_turn` 返回，進行中的工具**不會**被中斷，跑完後 agent 在下一次呼叫模型時併入第二則，最後只產生一則同時遵循兩個要求的回覆，第二個 `session/prompt` 在這時才返回。
- ACP 建立的會話寫入同一個 `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`，現有 synchronizer 會索引它；歷史讀取、全文檢索、Session Artifacts 都不需要修改。

前一個 change 已有：全域待審批池（`PendingApprovalsContext`）、側邊欄收件匣、`IProviderRuntime.getPendingApprovals(userId, sessionId?)`、Codex 的審批卡片（依 `context.decisions` 顯示選項、`context.expiresAt` 顯示期限）。

## Goals / Non-Goals

**Goals:**
- 預設模式下，需要審批的工具在頁面上出現審批卡片，允許或拒絕的結果確實回到 CLI。
- 審批項目進入全域待審批池：綁定發起者 `userId`、重新整理或切換會話後仍可審批、逾時與中斷時正確清除。
- 權限模式與 ACP 實際提供的模式一致。
- 失敗（未登入、行程意外退出、協議錯誤）時頁面有明確錯誤，不會停在「處理中」。

**Non-Goals:**
- ACP 客戶端的 `fs` / `terminal` 能力：`clientCapabilities` 全部為 `false`，檔案讀寫與指令執行仍由 CLI 自己處理。
- 把 Codex 的審批回覆改走新的通用訊息（見 D4，列為後續）。
- 長駐、跨多輪重用的 ACP 行程。

## Decisions

### D1. 每一輪啟動一個 `agy acp` 行程，而不是每個會話一條長駐連線

流程：spawn `agy acp` → `initialize` → 新會話用 `session/new`，續接用 `session/resume` → 依權限模式 `session/set_mode` → `session/prompt` → 所有 `session/prompt` 都返回後（見 D8）關閉 stdin 並結束行程。

- **為何不長駐**：長駐需要閒置回收、多個瀏覽器分頁共用連線、行程意外退出後重連，複雜度明顯較高。每輪啟動的成本與現在的 headless 相同（現在本來就是每輪 spawn），審批只發生在一輪之內，不需要跨輪連線。
- **代價**：每輪續接時 CLI 仍會在 transcript 寫入「伺服器重啟、子 agent 已停止」的系統訊息；歷史讀取已略過這類步驟（commit `1c06034f`）。

### D2. 協議連線沿用 Codex app-server 的寫法

新增一個小的 JSON-RPC over stdio 類別（請求逾時、未完成請求在行程退出時一律 reject、stderr 只當診斷不當協議），放在 Antigravity 模組內。不與 `CodexAppServer` 合併：兩者的初始化、參數與事件完全不同，共用只剩約 40 行的傳輸層，抽象的成本大於重複。

ACP 沒有可生成的型別，所以以**實測錄製的 fixture**（`docs/fixtures/antigravity/acp-*.jsonl`）固定協議形狀，映射與審批邏輯的單元測試都以這些 fixture 為輸入。

### D3. 即時事件映射沿用 `antigravity-tool-mapper`

`tool_call` / `tool_call_update` 的 `name`、`args` 與 headless 一致，所以工具名稱與參數仍由 `mapAgyTool` 映射成 Claude 工具形狀；新增 `mapAcpUpdate(update)` 處理 ACP 的外層結構：

| ACP `sessionUpdate` | 輸出 |
| --- | --- |
| `agent_message_chunk` | `stream_delta`；一輪結束時 `stream_end` + 完整 `text` |
| `agent_thought_chunk`（若出現） | `thinking` |
| `tool_call` | `tool_use`（`toolId = toolCallId`） |
| `tool_call_update`（`completed` / `failed`） | `tool_result`（`isError` 依狀態與內容） |
| 其他（`user_message_chunk`、`session_info_update`、`available_commands_update`、`plan` 等） | 略過；若實測出現 `plan`，另行映射為 `TodoWrite` |

`tool_call_update` 的結果內容形狀以實測 fixture 為準（任務 1.x 錄製），不先猜。

### D4. 審批：伺服器端小型審批池 + 通用的決定回覆訊息

- 後端收到 `session/request_permission` 時建立一筆待審批項目：`requestId`、`userId`（發起這一輪的使用者）、`sessionId`、`toolName` / `input`（經 `mapAgyTool` 映射，卡片顯示如 `Bash: ls -la`）、`context.decisions`（由 ACP `options` 轉成 `allow` / `deny`）、`context.expiresAt`。送出 `permission_request` 給前端，並由 `runtime.getPendingApprovals` 提供給全域池。
- 決定回覆：新增 WebSocket 訊息 `permission-decision { provider, requestId, sessionId, decision }`，由 `chat-websocket.service.ts` 分派到 `runtime.resolveApproval(requestId, userId, decision)`；呼叫者不是發起者、或 `decision` 不在 `context.decisions` 內就拒絕，並回覆警告（與 Codex、Claude 相同的嚴格比對）。
- 前端：審批卡片與送出邏輯改為依「請求是否帶 `context.decisions`」決定顯示選項清單並送 `permission-decision`，不再新增 `provider === 'antigravity'` 分支。Codex 的請求同樣帶 `context.decisions`，所以卡片顯示不變；Codex 的送出暫時保留現有 `codex-permission-response`，之後再統一。
- **為何不重用 `codexApprovals`**：它綁定 Codex 的 method 名稱與回覆格式（`decision` / `permissions`），改成通用版要動 Codex 已驗證的路徑。Antigravity 的審批池只需要新增、決定、逾時、依執行個體清除、依使用者列出五個操作。

### D5. 逾時、中斷與行程結束

- 逾時：預設 10 分鐘（與 Claude、Codex 一致），到期回覆 `deny`，送出 `permission_cancelled { reason: 'expired' }`。
- 中斷：先送 `session/cancel`；依 ACP 規範，未回覆的 `session/request_permission` 必須以 `{ outcome: { outcome: 'cancelled' } }` 回覆；等待 `session/prompt` 以 `stopReason: 'cancelled'` 返回，7 秒內沒返回就結束行程。送出一次 `complete { aborted: true }`（runtime 的 `emitsTerminal: true`）。
- 行程意外退出或 JSON-RPC 錯誤：未完成的請求全部 reject、該輪的待審批項目全部清除並送 `permission_cancelled`，頁面收到一則 `error` 與 `complete`。

### D6. 權限模式

`PROVIDER_INFO.antigravity.permissionModes` 改為 `default`、`acceptEdits`、`plan`、`bypassPermissions`：

- `default` / `acceptEdits` / `plan` → 對應 ACP 的 `default` / `accept-edits` / `plan`，在 `session/prompt` 前以 `session/set_mode` 設定。
- `bypassPermissions` → ACP 沒有對應模式，由客戶端對每個 `session/request_permission` 自動回覆 `allow`。只有在使用者已明確同意（現有 `antigravity-settings` 的 `explicitConsent && skipPermissions`）時才是預設值。若實測 `agy acp --dangerously-skip-permissions` 可用，則改傳這個旗標，不由客戶端代答。

### D7. 模型與登入

- 模型：以 ACP 能力設定（`session/set_model` 或 `configOptions`，任務 1.x 實測決定）；若都不可用，啟動時傳 `--model`。
- 登入：`initialize` 或 `session/new` 回傳需要驗證的錯誤時，送出明確訊息（請先在終端執行 `agy` 完成登入），不在頁面內實作 OAuth 流程。

### D8. 執行中插話：同一條連線再送 `session/prompt`

- `runtime.steer(sessionId, userId, text)`：這一輪的 ACP 連線存在、尚未進入收尾，且呼叫者是發起者時，送出 `session/prompt { sessionId, prompt: [{ type: 'text', text }] }`，不等它返回就回覆 `{ ok: true }`；否則回覆 `not_running` / `not_owner` / `empty`。
- **這一輪何時結束**：計算尚未返回的 `session/prompt` 數量，**全部返回**後才送 `complete` 並結束行程。因為第一個 prompt 會在插話送出時提前以 `end_turn` 返回，如果照 D1 原本的寫法「收到 `stopReason` 就結束」，會把插話那一段截掉。
- 收尾開始後（數量歸零、準備關閉）到行程結束之間收到的插話，一律回覆 `not_running`，由前端保留在佇列。
- 中斷時，所有未返回的 prompt 都會以 `cancelled` 返回，沿用 D5。
- `stopReason` 取最後一個返回的 prompt；任一個以錯誤返回，就照錯誤路徑處理。
- **為何不用 print 模式的 `--input-format stream-json`**：實測它把每一行當成獨立的一輪依序執行，插話要等目前這一輪結束才生效；結構體裡沒有投遞方式欄位，`control_request` 回覆 "not supported yet"。

## Risks / Trade-offs

- [ACP 一定要有人回覆審批，否則這一輪會一直等] → 10 分鐘逾時自動拒絕；中斷與行程結束時一律清除；全域收件匣讓使用者在其他會話也看得到待審批項目。
- [協議沒有生成型別，CLI 升級可能改欄位] → 以實測 fixture 固定形狀並寫測試；`initialize` 回報的 `agentInfo.version` 記入診斷訊息；啟動時若 `protocolVersion` 不是 1 就回報錯誤。
- [每輪啟動行程的延遲] → 與現況相同，不惡化；若之後成為問題，再評估長駐連線。
- [前端審批卡片改為依 `context.decisions` 分流，會碰到 Codex 已驗證的顯示路徑] → 改動限於判斷條件；驗收時重跑 Codex 審批（允許、拒絕各一次）。
- [`bypassPermissions` 由客戶端代答，比 CLI 原生旗標多一層] → 只在使用者明確同意時啟用；若 CLI 旗標可用就改用旗標。
- [插話的併入行為不在 ACP 規格內，屬於 agy 的實作細節，升級可能改變] → 以錄製的 fixture 固定「第一個 prompt 提前返回、最終只有一則回覆」的形狀並寫測試；驗收時實測一次。
- [插話恰好在第一個 prompt 返回、行程準備關閉時送出] → 收尾開始後的插話回覆 `not_running`，前端把訊息留在佇列，不會遺失。

## Migration Plan

- 直接替換 Antigravity 執行層，不保留 headless 路徑；移除臨時修正 `findPermissionDeniedNotice`。
- 已存在的會話不需要遷移：ACP 續接時使用同一個 `brain/<id>` 目錄與 transcript。
- 回滾：revert 本 change 的 commit 即回到 headless 實作。

## Open Questions

- `tool_call_update` 完成時的結果內容形狀（`content` 陣列？`rawOutput`？），以任務 1.x 錄製的 fixture 決定。
- 模型設定方式（`session/set_model`、`configOptions` 或 `--model`）。
- `agy acp` 是否接受 `--dangerously-skip-permissions`。
- 被拒絕後，模型是繼續回覆還是結束這一輪；頁面需要的「被拒結果」以實測為準（至少工具卡片顯示為錯誤）。
- 插話落在審批等待中（工具尚未執行）時的行為：是等審批後併入，還是有其他效果，以任務 1.1 錄製確認。
- research.md 中 agy acp 的已知問題（skills 不出現、`authenticate` 逾時、串流卡住）在 1.5.3 是否仍存在。
