> **狀態：重啟（2026-11-09）**。2026-11-05 曾暫緩（理由與三家調研見 [research.md](./research.md)）。重啟原因：要對齊 Gemini App 的「send now」，而 agy 的 print 模式（`-p --input-format stream-json`）實測只能把插話排成下一輪，沒有任何欄位能指定投遞方式；`agy acp` 則會把執行中的第二個 `session/prompt` 併入目前這一輪。範圍仍只涵蓋 Antigravity，研究建議的「不分 provider 的 ACP 執行層」不在本 change。

## Why

Antigravity 目前每一輪都以 headless 模式（`agy --prompt … --output-format stream-json`）執行，沒有任何管道把審批決定傳回 CLI。預設模式下，需要審批的工具會被 CLI 自動拒絕，模型隨即放棄；CLI 仍回報 `SUCCESS`、結束碼 0，原因只寫在 stderr。使用者只看到一張失敗的工具卡片和空回覆，無法在頁面上允許任何操作，只能改用「跳過所有權限」。

agy 1.5.0 提供 `agy acp`（Agent Client Protocol）。實測確認它會在工具執行前向客戶端發出 `session/request_permission`，回覆後才繼續，所以現在可以做到真正的互動審批。

另外，Antigravity 目前不支援執行中插話。Gemini App 的做法是：生成中送出的訊息先排隊，按下「send now」才插入，而且不中斷模型。print 模式做不到這一點，只有 ACP 能做到（2026-11-09 以 agy 1.5.3 實測）。前一個 change（`unify-agent-rendering-and-provider-cleanup`）已經建好全域待審批池與收件匣，Antigravity 接上去即可。

## What Changes

- **BREAKING**（內部）：Antigravity 執行層從「每輪啟動一次 headless 行程」改為「每個會話一條 `agy acp` 長連線」，以 JSON-RPC over stdio 溝通。`server/antigravity-cli.js` 的 headless 實作移除。
- 需要審批的工具在頁面上出現審批卡片，允許或拒絕的結果回傳給 CLI；審批項目進入全域待審批池，綁定發起者 `userId`，可從側邊欄收件匣跳轉審批。
- 審批逾時（預設 10 分鐘）自動回覆拒絕並送出 `permission_cancelled`；中斷、行程結束或會話結束時清除該會話的待審批項目。
- 權限模式改為 ACP 實際提供的 `default`、`accept-edits`、`plan`，另保留「跳過權限」（由客戶端自動允許，需使用者明確同意，沿用現有設定）。
- 續接舊會話使用 `session/resume`（不重播歷史）；中斷使用 `session/cancel`。
- CLI 未登入或 ACP 初始化失敗時，回傳明確錯誤訊息，不卡住。
- 移除前一次的臨時修正（從 stderr 偵測「auto-denied」再轉成警告），ACP 下不再有這條路徑。
- 支援執行中插話：`chat-steer` 在同一條 ACP 連線上送出第二個 `session/prompt`，由 agy 在下一次呼叫模型時併入目前這一輪；`midTurnSteer` 改為 `true`。

不做：ACP 的 `fs` / `terminal` 客戶端能力（`clientCapabilities` 全部為 `false`，由 CLI 自己讀寫檔案與執行指令）。

## Capabilities

### New Capabilities
- `antigravity-acp-runtime`: Antigravity 以 ACP 執行對話，包含互動審批、權限模式、續接、中斷、逾時與錯誤處理、執行中插話，以及接入全域待審批池的行為。

### Modified Capabilities
（無。`openspec/specs/` 目前沒有涵蓋 Antigravity 執行或審批的既有規格。）

## Impact

- 後端：`server/antigravity-cli.js`（改寫）、`server/modules/providers/list/antigravity/antigravity-runtime.provider.ts`（新增 `getPendingApprovals`，`abort` 改走 `session/cancel`）、`antigravity-tool-mapper.ts`（新增 ACP `tool_call` / `tool_call_update` 的映射，沿用既有工具名稱表）、`chat-websocket.service.ts`（新增 `antigravity-permission-response` 或改為通用審批回覆）。
- 共用：`shared/providers.ts` 中 Antigravity 的 `permissionModes`、預設模式與 `midTurnSteer`。
- 前端：審批卡片沿用現有元件；權限模式按鈕依資訊表顯示，可能需補 i18n。
- 不受影響：ACP 會話寫入同一個 `brain/<id>/.system_generated/logs/transcript.jsonl` 並已被同步進索引，所以歷史讀取、全文檢索、Session Artifacts、側邊欄不需要修改。
- 依賴：agy CLI ≥ 1.5.0（提供 `acp` 子命令）；插話行為以 1.5.3 實測。
- 相關：`chat-queued-steer-composer` 提供「排隊 + 立即引導」的輸入框；本 change 完成後 Antigravity 的佇列項目才會出現立即引導按鈕。
