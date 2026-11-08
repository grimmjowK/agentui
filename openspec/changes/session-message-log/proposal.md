## Why

聊天頁始終做不到所見即所得：同一段對話在「執行中、剛結束、拉過一次歷史、整頁重新整理」四個時點會呈現四種不同結果，錯誤訊息的位置會漂移，重新整理後甚至消失。根因不在個別 bug，而在架構——畫面是瀏覽器把兩份來源不同、內容不同、時間戳語意不同的資料（即時 WebSocket 流與 provider 自己的歷史檔）用 id、文字指紋、相鄰去重與時間戳插入拼起來的，結果取決於拉取時機；而應用自己產生的訊息（錯誤、警告、中斷標記）從未持久化，只活在瀏覽器記憶體裡。`unify-agent-rendering-and-provider-cleanup` 後續幾輪修正（id 契約、相鄰去重、欄位疊加方向、警告保留、暫時性錯誤過濾）都在補這條縫，同類問題仍持續出現，需要換掉前提。

## What Changes

- **新增伺服器端對話日誌**：每則送往前端的持久性訊息（使用者訊息、助手文字、思考、工具呼叫與結果、錯誤、警告、中斷標記、壓縮邊界）在送出前由伺服器指派該會話內單調遞增的序號 `seq`，寫入 SQLite，再送出。同一 id 的後續更新（如工具從 started 到 completed、串流收尾）就地更新內容、保留原序號。
- **建立不變量「任意時點的畫面 = 重新整理後的畫面」**：頁面載入讀日誌，執行中把同樣帶 `seq` 的訊息接到尾端；顯示順序完全由 `seq` 決定，不再依時間戳排序。
- **重新連線補回**：重新連線（含整頁重新整理）時依 `seq` 補回斷線期間遺漏的訊息；執行中尚未定稿的段落由伺服器在記憶體中保留並補送，重新整理後立即看到完整的前半段。
- **provider 歷史檔降為匯入與補齊來源**：沒有日誌的既有會話、或在終端機直接進行的回合，由伺服器在讀取時把日誌中尚未有的訊息依 provider 順序匯入日誌；provider 歷史中內容更完整的欄位（如 Antigravity 的完整 diff）由伺服器按 id 補回日誌。合併只發生在伺服器端。
- **前端移除合併啟發式**：`computeMerged` 的時間戳插入、相鄰同文去重、文字指紋比對、錯誤包裝去重、暫時性錯誤過濾，以及 `refreshFromServer` 的保留白名單，改為「按 id 更新、按 `seq` 排序」。樂觀使用者訊息改以客戶端產生的 id 送出，由伺服器記錄並回送 `seq` 後取代。
- **新增所見即所得驗收**：以錄製的 provider 事件流在伺服器端重放，斷言「執行中前端累積的訊息序列」與「結束後重新讀取的訊息序列」逐則相同；並保留瀏覽器端取樣比對作為發版前的手動驗收。
- 歷史分頁改以 `seq` 為游標（**BREAKING**：`/api/providers/sessions/:id/messages` 的 `offset` 參數由 `beforeSeq` 取代；過渡期兩者並存，移除旗標時才移除 `offset`；前端同步調整，無外部使用者）。

方案取捨（完整事件日誌 vs. 只持久化應用自產訊息並以錨點定位）見 design.md；已決議採用完整事件日誌。

## Capabilities

### New Capabilities
- `session-message-log`: 伺服器端對話日誌的契約——哪些訊息必須寫入、序號如何指派與保持、同 id 更新規則、會話 id 尚未確定前的暫存、既有會話與終端機回合的匯入與補齊、讀取與分頁介面。
- `chat-view-consistency`: 前端呈現的契約——訊息順序只由 `seq` 決定、即時與重新讀取必須產生相同序列、樂觀訊息的取代規則，以及驗證此不變量的驗收要求。

### Modified Capabilities
<!-- 無：openspec/specs/ 中沒有涵蓋聊天訊息合併或排序的既有規格。
     fix-chat-sync-and-transcript-coverage 的 chat-session-sync（廣播 → 重新拉取鏈路）維持有效，
     本變更只改變「拉回來的是什麼、怎麼呈現」。 -->

## Impact

**後端**
- `server/modules/database/`：新增 `session_messages` 資料表、遷移與 repository。
- `server/modules/websocket/services/`：新增 `LoggingWriter`，在派發處包裝 WebSocket writer，送出前寫日誌、補上 `seq`；會話 id 確定前暫存；累加執行中段落供重新連線補送。外部 REST API（`/api/agent`）可接續既有會話，同樣以 `LoggingWriter` 包裝。
- `server/modules/websocket/services/chat-websocket.service.ts`：`chat-command` 時以客戶端 id 記錄使用者訊息。
- 各 sessions provider 的 `fetchHistory`：改為供匯入／補齊使用；讀取 API 改讀日誌。
- `server/modules/providers/provider.routes.ts`：訊息讀取與分頁參數。

**前端**
- `src/stores/useSessionStore.ts`：移除合併啟發式，改為按 id upsert、按 `seq` 排序。
- `src/components/chat/hooks/useChatRealtimeHandlers.ts`、`useChatSessionState.ts`、`useChatComposerState.ts`：串流收尾、樂觀訊息、分頁游標。

**相依與風險**
- 依賴 `unify-agent-rendering-and-provider-cleanup` 建立的即時／歷史 id 契約；Cursor 尚未有 id 契約，匯入前需先補（見 design）。
- 儲存成本：每則訊息多一份 JSON。單則上限 512 KB；日誌依時間（預設 90 天）與總大小（預設 1 GB）以會話為單位清理，收藏與執行中的會話不清理，被清理的會話再次打開時由 provider 歷史重新匯入。
- 無新增外部依賴（沿用 better-sqlite3）。
