## Context

聊天訊息目前有兩條互相獨立的產生管線：

- **即時流**：各 runtime 轉接層（`claude-sdk.js`、`openai-codex.ts`、`antigravity-cli.js`、`cursor-cli.js`）把 CLI／SDK 事件映射成 `NormalizedMessage`，經 `WebSocketWriter.send` 送出。`send` 在連線斷開時直接丟棄訊息。
- **歷史**：各 sessions provider 的 `fetchHistory` 重新解析 provider 自己的檔案（Claude jsonl、Codex rollout、Antigravity transcript、Cursor store.db）。

前端 `useSessionStore` 以「伺服器歷史 + 即時獨有訊息」組合畫面（`computeMerged`），用 id、使用者文字指紋、相鄰同文去重、錯誤包裝去重、時間戳插入（`interleaveByTimestamp`）拼接；`refreshFromServer` 再以白名單決定保留哪些即時訊息。訊息不寫入任何本地儲存（store 註解：*Backend JSONL is the source of truth*）。

實測與程式碼核對得到的事實：

1. 兩條管線的內容不同：Antigravity 即時工具參數只有摘要、歷史有完整 diff；即時文字分段串流、歷史是整則；Codex 歷史多出它注入的 AGENTS.md 使用者訊息。
2. 應用自產的訊息（伺服器端 16 處 `kind: 'error'`、`task_notification` 警告、中斷標記、插話被拒）從未持久化，整頁重新整理後消失。
3. 時間戳語意不一：即時訊息是伺服器送出時間；串流暫存訊息是瀏覽器時間且持續更新；Antigravity 歷史是步驟開始時間；Cursor 歷史是捏造的 `baseTime + sequence × 100ms`；重試錯誤在 `bf2f4eaa` 後延到結束才送。依時間戳插入，錯誤的位置取決於時鐘相對誤差。
4. 唯一可靠的順序——伺服器收到事件的先後——沒有被記錄。

SQLite（better-sqlite3）已用於 sessions／projects 索引；資料庫遷移集中在 `server/modules/database/migrations.ts`。UI 發起的聊天執行都經過 `chat-websocket.service.ts` 的 `runtime.start` / `runtime.reconnect`。另有外部 REST API（`/api/agent`，`routes/agent.js`）供 CI、n8n 等以 API key 呼叫，可建立新會話或以 `sessionId` 接續既有會話，結果以 SSE 或一次性回應回給呼叫端。

## Goals / Non-Goals

**Goals:**
- 不變量：對任一會話，在任意時點，前端的訊息序列與「重新整理後讀取並重新連線」的序列逐則相同（id、順序、內容），包含尾端串流中、尚未定稿的那一段。
- 顯示順序只由伺服器指派的序號決定，與任何時鐘無關。
- 錯誤、警告、中斷標記持久化，重新整理後位置不變。
- 斷線或重新整理期間的訊息在重新連線後可補回，包含串流中已輸出的前半段。
- 合併只在伺服器端發生；前端不再有拼接啟發式。

**Non-Goals:**
- 不改變各 provider 的 CLI／SDK 整合方式與工具映射（沿用 `tool-call-rendering`）。
- 不處理終端機與 UI 同時對同一會話寫入（既有的 Codex handoff 已阻止並發；其他 provider 維持現狀）。
- 不做跨裝置即時協作或訊息編輯。
- 串流中的半段文字不寫入資料庫（改以記憶體保留並在重新連線時補送，見 D10）。

## Decisions

### D1. 採用完整事件日誌（方案 A），不採只持久化自產訊息（方案 B）

| | A：完整事件日誌 | B：自產訊息 + 錨點 | C：維持現況繼續補 |
|---|---|---|---|
| 做法 | 所有持久性訊息寫入日誌，日誌為唯一來源；provider 歷史只用於匯入與補齊 | 只把錯誤／警告／中斷寫入資料庫並記錄「接在哪一則 provider 訊息之後」；合併搬到伺服器端 | 繼續調整前端拼接規則 |
| 重新整理後錯誤消失 | 解決 | 解決 | 未解決 |
| 錯誤位置漂移 | 解決（序號） | 解決（錨點） | 未解決 |
| 即時 vs 歷史內容差異 | 解決（伺服器補齊後寫回，前端只讀一份） | **未解決**：執行中前端仍需合併即時與歷史 | 未解決 |
| 斷線補回 | 可依序號重放 | 不支援 | 不支援 |
| 成本 | 中到大：資料表、writer 包裝、匯入對帳、前端 store 重寫 | 中：資料表、錨點計算、伺服器端合併 | 低，但持續發生 |

B 仍保留「執行中前端合併兩份來源」，所以「執行中的畫面 = 重新整理後的畫面」在 B 下無法成立，只能逼近。A 的額外成本主要在匯入對帳（D7、D8），而這部分 B 的錨點計算也躲不掉。因此採 A。

A 的分階段（見 Migration Plan）讓第一階段「只寫不讀」就能先驗證資料正確性，降低一次切換的風險。

### D2. 在派發處包裝 writer，作為唯一寫入點

在 `chat-websocket.service.ts` 呼叫 `runtime.start` / `runtime.reconnect` 前，以 `LoggingWriter` 包裝原 writer。`LoggingWriter.send(message)`：

1. 判斷是否為持久性訊息（D3）；
2. 是則寫入日誌（D4），把 `seq` 加到訊息上；
3. 交給原 writer 送出。

**為何不在各 runtime 內寫**：runtime 有四個、送出點數十處（含 Antigravity 的 `liveWriter`、Claude 的 `reconnectSessionWriter`），逐一修改容易遺漏；派發處是所有執行的共同入口。Antigravity 重新連線時傳入的新 writer 也經過派發處，同樣被包裝。

**派發處的其他送出路徑也必須經過日誌**：`chat-websocket.service.ts` 每條連線只建一個原始 `WebSocketWriter`，除了 `runtime.start` / `runtime.reconnect`，下列路徑也直接用它送出或把它交給 runtime：

| 路徑 | 現況 | 處理 |
|---|---|---|
| `runtime.reconnect` | 每次重新連線傳入新的原始 writer；Codex 直接 `state.writer = writer` 整個替換（`openai-codex.ts:326`） | **不新建** `LoggingWriter`：先以會話 id 查 D10 登記表，查到就對該實例 `updateWebSocket(新 ws)` 後傳給 `runtime.reconnect`；查不到（執行已結束）才包新的。這樣不論 runtime 是換 socket 還是換 writer，拿到的都是同一個實例 |
| `abort-session` | `runtime.abort(sessionId, writer)` 收到原始 writer；Claude／Cursor 的 `complete` 由派發處直接送 | `runtime.abort` 改傳該會話登記的 `LoggingWriter`（D10 登記表）；查不到時（例如該次執行已結束）才用原始 writer。`complete` 不入日誌，維持直接送出。中斷成功時由伺服器產生中斷標記（D3） |
| 審批失敗的 `task_notification`（Codex、Claude） | 原始 writer 直接送 | 屬 D3 的持久性種類，改經日誌寫入 |
| `chat-steer` | 只回 `steer-accepted` / `steer-rejected`（帶前端的 `clientId`，`chat-websocket.service.ts:180`），插話文字本身不記錄 | 沿用現有的 `clientId` 欄位；接受時以該 id 寫入使用者訊息（同 D6），被拒時不寫 |

為了不靠人工清點，派發處所有送出改走同一個函式 `sendToClient(writer, message)`：持久性訊息先寫日誌，再交給 writer。另加不變量測試：以假的 ws 收集一整輪（含中斷、審批失敗、插話）送出的訊息，斷言**每則持久性種類的訊息都帶 `seq`**；任何繞過日誌的新路徑都會讓這個測試失敗。

**`LoggingWriter` 必須完整代理 writer 介面**：runtime 會讀寫 `ws`、`userId`、`sessionId`，並呼叫 `updateWebSocket`、`setSessionId`、`getSessionId`（Claude `claude-sdk.js:865`、Antigravity `antigravity-cli.js:56` 依 `updateWebSocket` 是否存在決定「換底層 socket」或「換整個 writer」）。`LoggingWriter` 須提供同名成員並轉給內層 writer，確保重新連線時走「換底層 socket」分支，同一次執行自始至終是同一個 `LoggingWriter` 實例（D10 依賴此點）。

**runtime 依 writer 標記決定送物件或字串**：Codex（`openai-codex.ts:67-68`）與 Antigravity（`antigravity-cli.js:25-28`）的 `send` 只在 `writer.isWebSocketWriter || writer.isSSEStreamWriter` 為真時送 `NormalizedMessage` 物件，否則送 `JSON.stringify` 後的字串。若 `LoggingWriter` 沒有這個標記，它收到的是字串，讀不到 `kind`、`id`、`toolId`，這兩家的持久性訊息會全部漏寫。因此：

- `LoggingWriter` 固定宣告 `isWebSocketWriter = true`，讓 runtime 一律送物件給它；實際的傳輸格式由內層 writer 決定（`WebSocketWriter`、`SSEStreamWriter` 收物件，`ResponseCollector` 物件與字串皆可處理，`routes/agent.js:452-520`）。
- 防禦性處理：`LoggingWriter.send` 若仍收到字串，先 `JSON.parse` 再走日誌流程，解析失敗則原樣轉給內層 writer 並 `logger.warn`。
- 驗收測試 MUST 以**真實的** Codex、Antigravity runtime 驅動 `LoggingWriter`（假 app-server／假 agy 執行檔），不能只對 `LoggingWriter` 直接呼叫 `send`，否則測不到這類 transport sniffing。

**外部 REST API 同樣包裝**：`/api/agent` 接受 `sessionId` 並傳給 `runtime.start`（`routes/agent.js:843`、`:948`），可以接續既有會話。若不包裝，接續期間既不寫日誌、也不登記 `LoggingWriter`，UI 同時打開該會話時，D7 會把它當成非執行中，匯入寫到一半的 provider 歷史。因此 `/api/agent` 與聊天 WebSocket 一樣，在呼叫 `runtime.start` 前以 `LoggingWriter` 包裝 `SSEStreamWriter` 或 `ResponseCollector`，新會話與接續都包裝、不分情況。`LoggingWriter` 只依賴內層 writer 的 `send`／`setSessionId` 等成員，不需要為兩種 writer 寫分支。

**歸屬以訊息自身的 `sessionId` 為準**，不用 `writer.sessionId`：一條 WebSocket 連線共用一個 writer，可能先後承載多個會話。

### D3. 持久性訊息的範圍

| 寫入日誌 | 不寫入（只即時送出） |
|---|---|
| `text`（使用者、助手）、`thinking`、`tool_use`、`tool_result`、`error`、`task_notification`（`warning`/`error`）、中斷標記（`isInterrupted`）、壓縮邊界 | `stream_delta`、`stream_end`、`status`、`session_created`、`complete`、`permission_request` / `permission_cancelled`、`task_notification`（`info`） |

**`tool_result` 一律併入同 `toolId` 的 `tool_use`**。現況三家形態各異：Codex 即時以同 id 的 `tool_use` 帶 `toolResult`；Antigravity 即時另送一則 id 為 `agy_tool_N:result` 的獨立 `tool_result`；Claude 即時與歷史都有 id 為 `${uuid}_tr_${toolId}` 的獨立 `tool_result`；三家的歷史解析又都把結果掛回 `tool_use.toolResult`，但 Codex／Claude 仍在回傳陣列中保留獨立的 `tool_result`（Codex 的還是每次讀取都不同的隨機 id）。日誌只採一種形態：`LoggingWriter` 收到帶 `toolId` 的 `tool_result` 時，不新增資料列，而是把內容（`content`、`isError`、`toolUseResult`、`subagentTools`）寫進同會話中 `toolId` 相同的 `tool_use` 列的 `toolResult`（保留其 `seq`），並把更新後的 `tool_use` 送往前端；找不到對應 `tool_use` 時才以 `${toolId}:result` 為 id 獨立寫入。D7 對帳時忽略歷史中的獨立 `tool_result`（其內容已由 provider 掛到 `tool_use.toolResult`，經補齊寫回）。前端渲染本來就依 `toolId` 合併（`useChatMessages.ts:25`），畫面不受影響。只在日誌層處理一次，不修改三個 runtime 的送出形態。

**中斷標記由伺服器產生**。現況只有 Codex 在伺服器端送出 `isInterrupted` 訊息；Claude、Antigravity、Cursor 的中斷氣泡是前端收到 `complete(aborted: true)` 時在瀏覽器端合成的（`useChatRealtimeHandlers.ts:278-295`，id 為 `interrupted_${Date.now()}`），從未持久化。改為：`LoggingWriter` 收到 `complete` 且 `aborted: true`、而該次執行尚未送出過 `isInterrupted` 訊息時，先以 `${sessionId}:interrupted:${runId}`（`runId` 為該 `LoggingWriter` 實例的 id）寫入一則 `role: 'user'`、`content: '<turn_aborted>'`、`isInterrupted: true` 的訊息並送出，再送 `complete`。同時移除前端的本地合成。

串流文字在 `stream_end` 時以 `messageId` 定稿，隨後同 id 的 `text` 寫入日誌（沿用 `unify-agent-rendering-and-provider-cleanup` 的 id 契約）。Claude 的 `stream_end`（`claude-sessions.provider.ts:414`）目前不帶 `messageId`；由於 `claude-sdk.js` 未開啟 `includePartialMessages`，Claude 即時路徑實際上不送串流事件，現況不受影響。為防日後開啟串流時退化，前端規則定為：不帶 `messageId` 的 `stream_end` 不把暫存轉成隨機 id 的正式訊息，而是保留暫存，直到收到下一則帶 `seq` 的助手 `text` 或 `complete` 時清除（D9）。串流中的半段文字不寫入資料庫：每個 delta 寫一次的寫入量過大。改由 `LoggingWriter` 在記憶體中累加該會話目前段落已送出的文字，於重新連線時補送（D10），段落定稿或執行結束即清除。

### D4. 序號與同 id 更新

資料表 `session_messages`：

| 欄位 | 說明 |
|---|---|
| `session_id` TEXT | |
| `id` TEXT | 訊息 id（即時／歷史契約 id） |
| `seq` REAL | 顯示順序鍵；同會話內唯一 |
| `provider_ids` TEXT | 對應的 provider 歷史 id（JSON 陣列，見 D8） |
| `payload` TEXT | 完整 `NormalizedMessage` JSON |
| `source` TEXT | `live` / `import` |
| `created_at` / `updated_at` | 僅供稽核，不參與排序 |

主鍵 `(session_id, id)`，索引 `(session_id, seq)`。

- **兩種寫入，兩條規則**：即時寫入（經 `LoggingWriter`）的新訊息 `seq = floor(max(seq)) + 1`，永遠大於目前最大值；D7 對帳匯入的訊息可以插入既有兩則之間（中點）。`seq` 只定義**顯示順序**，不代表伺服器收到的先後；即時訊息的到達順序恰好與顯示順序一致，是「即時一律追加」的結果，而不是 `seq` 的定義。better-sqlite3 是同步呼叫，在單一行程內與寫入同交易即為原子操作。**前提是同一個資料庫檔只有一個伺服器行程寫入**：k8s 部署若有多個副本共用同一個 SQLite 檔（共享卷），序號會衝突、D10 的記憶體登記表也只存在於其中一個副本。實作前須確認部署為單一副本，並在部署文件中註明；若之後需要多副本，必須先把會話黏著到同一副本，或改用伺服器端集中的序號來源。
- 同 id 再次送出（工具從 started 到 completed、`text` 覆蓋串流定稿）：就地更新 `payload`、保留 `seq`。欄位合併規則：新值非 `undefined`/`null` 才覆蓋（即時流的後續事件比前一個事件完整，與 D7 的「歷史補齊」方向不同）。
- 送出給前端的訊息一律帶 `seq`；更新也帶原 `seq`，前端按 id upsert。

`seq` 用 REAL 是為了 D7 的中段插入（取前後兩則的中點）；一般追加維持整數。

### D5. 會話 id 確定前的暫存

新會話在 `session_created` 之前，訊息的 `sessionId` 為 null（Claude 在第一個 SDK 訊息前、Codex 在 `thread/start` 前、使用者訊息在派發時）。`LoggingWriter` 為每次執行（每次 `runtime.start` 呼叫建立一個實例）保留暫存佇列，收到 `session_created` 或 `setSessionId` 時依原順序寫入並指派序號，再送出。因為一次執行對應一個 `LoggingWriter` 實例，同一連線上並行的兩個新會話不會互相混入。

**會話 id 何時算「確定」**：新會話（`runtime.start` 未帶 `sessionId`）在收到 `session_created` 或 `setSessionId` 之前，一律視為未確定，**不採信訊息自帶的 `sessionId`**。原因是 Antigravity 在拿到 CLI `init` 的 `conversation_id` 之前用 `crypto.randomUUID()` 當臨時 id（`antigravity-cli.js:295`），CLI 未安裝（`:315`）與 spawn 失敗時的錯誤就帶著這個臨時 id 送出，若照收會寫進一個不存在的會話。接續既有會話（帶 `sessionId`）時一開始即視為確定。執行結束時若仍未確定（例如 CLI 根本沒啟動），暫存訊息照常送往前端但**不寫入日誌**。

**釋放順序**：確定會話 id 時，先把暫存佇列依序寫入資料庫（使用者訊息因此拿到最小的 `seq`），對前端則**先送 `session_created`、再送暫存訊息**。前端在處理 `session_created` 之前還不知道目前會話 id（`useChatRealtimeHandlers.ts:232-255`），先送帶 `seq` 的訊息會被當成其他會話的訊息。

### D6. 使用者訊息由伺服器記錄

目前使用者訊息只存在於前端樂觀訊息與 provider 歷史。改為：前端送 `chat-command` 時附 `clientId`（沿用插話既有的欄位名，值為 UUID），派發處以它寫入一則使用者 `text`（含圖片的中繼資料，不含 base64 本體），送回帶 `seq` 的版本，前端以同 id 取代樂觀訊息。

**`clientId` 是不可信輸入**：日誌主鍵是 `(session_id, id)`、寫入是 upsert，若直接以客戶端送來的字串當 id，客戶端送 `clientId: "call_1"` 就能覆寫同名的工具訊息、甚至改變其 `kind`。因此：

- 伺服器 MUST 驗證 `clientId` 為 UUID 格式，不符即拒絕該請求（回 `error`，不寫日誌、不啟動 runtime）。
- 日誌 id 由伺服器加上專用前綴：`user:<clientId>`。provider 的 id 不會以 `user:` 開頭，兩者不可能撞名；前端以同樣規則換算後取代樂觀訊息。
- 寫入使用者訊息用 **insert-if-absent**，不走一般 upsert：同 id 已存在且是同一使用者、同一會話的使用者訊息時視為冪等重送，直接回傳既有那列；其他情況一律拒絕，MUST NOT 覆寫。

**圖片**：上傳端點把檔案轉成 base64 後刪除暫存檔（`server/index.js:929` 起），`ChatImage` 只有 `data` 與 `name`，目前沒有可持久化的路徑。日誌只存檔名與尺寸。為避免伺服器回送時縮圖消失，前端以同 id 取代樂觀訊息時**保留本地的 `images`**（只在記憶體中，不寫回日誌，也不送回伺服器）；這是 D9「按 id upsert」唯一的欄位保留例外，範圍只限使用者訊息的 `images`。重新整理後沒有縮圖，與現況相同。

> ponytail: 重新整理後縮圖消失；若要保留，需新增持久化的檔案路徑與縮圖端點，另案處理。

**寫入順序**：派發處 MUST 先記錄使用者訊息，再送出其他訊息。現況 `chat-websocket.service.ts:142` 在 `runtime.start` 之前先送並行終端警告（`warnOnConcurrentShellSession`），導入日誌後要調整為「記錄使用者訊息 → 送警告 → `runtime.start`」，使用者訊息才會排在警告之前。

### D7. 讀取時的匯入與補齊（伺服器端）

讀取 `/sessions/:id/messages` 時：

1. 讀日誌。
2. 讀 provider 歷史（依檔案 mtime 快取）。
3. 對帳，依 provider 歷史順序處理每則訊息：
   - **已在日誌中**（`id` 或 `provider_ids` 命中）：用歷史補齊日誌中缺少或不完整的欄位，寫回日誌（例：Antigravity `toolInput` 的完整 diff、Codex 的工具輸出）。歷史對「內容欄位」具權威；日誌獨有的欄位（`seq`、自產訊息）不動。
   - **不在日誌中**：視為匯入訊息。若它之後沒有任何已對應的訊息（尾端，例如在終端機進行的新回合，或日誌為空的既有會話），追加到尾端；若位於兩則已對應訊息之間（例如 Codex 注入的 AGENTS.md 使用者訊息），以前後兩則的 `seq` 中點插入。
4. 回傳日誌（依 `seq`）。

只在伺服器端合併，且寫回日誌，所以同一次結果之後每次讀取都相同。

**代價：錯配會被持久化**。舊做法的合併錯誤只影響當下畫面，重新整理即消失；寫回日誌後，一次錯配就是永久的重複或錯序。因此對帳加上三條限制：

- **執行中的會話只補齊、不匯入**（以 D10 的登記表判斷）。執行中 provider 歷史可能只寫了一半，且即時流尚未送出的訊息之後會以契約 id 到達；此時若把「尾端未對應」的歷史訊息匯入，契約只要有任何缺口就會產生兩份。執行結束後的第一次讀取再做完整對帳。
- **偵測 provider 端的刪減或分岔**：使用者可能在終端機對同一會話做 Claude `/rewind`、fork，或 Codex 回滾，provider 歷史變短或改寫，而 D7 的步驟只會新增與補齊。對帳時若發現日誌中「曾經對應過」的訊息在 provider 歷史中已不存在，且 provider 歷史非空，即判定為分岔，對該會話執行**重建**。「曾經對應過」只採計 D8 契約表中**標記為穩定**的 id（`id` 本身是穩定契約 id，或 `provider_ids` 中記錄的是穩定的 provider id）。不穩定的 id（例如 Codex 歷史目前每次讀取都重新產生的隨機 id）MUST NOT 記入 `provider_ids`，也 MUST NOT 參與分岔判斷，否則每次讀取都會誤判分岔、反覆重建並清掉自產訊息。
- **重建**＝在單一交易中刪除該會話的日誌，再依「日誌為空」的規則從 provider 歷史完整匯入。代價是應用自產訊息（錯誤、警告、中斷標記）在重建後消失，與 D13 清理後的結果相同。重建以 `logger.warn` 記錄會話 id 與觸發原因，並另提供管理端點手動觸發，作為錯配資料的修復入口。

> ponytail: 分岔時整會話重建會丟失自產訊息；若之後發現 rewind 很常見，再改為「保留錨點仍存在的自產訊息」。

### D8. id 契約是對帳的前提；使用者訊息以回合內順序對應

對帳依賴「同一則訊息在即時與歷史中 id 相同」，或至少「歷史中的 id 每次讀取都相同」。契約必須**逐訊息種類**定義，而不只是「助手文字與工具」。現況（對照 `feat/unify-agent-rendering-phase1` 程式碼核對）：

| 種類 | Claude | Codex | Antigravity |
|---|---|---|---|
| 助手文字 | SDK `uuid` = jsonl `uuid`（待 1.3 驗證） | ✅ `item.id` = rollout `payload.id` | ✅ `agy_${sessionId}_step_${step_index}` |
| 工具呼叫 | 同上 | ✅ `item.id` = `call_id` | ✅ `agy_tool_${step_index}` |
| 工具結果 | 獨立 `${uuid}_tr_${toolId}`，兩側一致 | ❌ 即時併入 `tool_use`；歷史另有獨立 `tool_result` 且為**隨機 id** | ❌ 即時獨立 `agy_tool_N:result`；歷史併入 `tool_use` |
| 推理（thinking） | 同助手文字 | ❌ 即時有 `item.id`；歷史 `mapRolloutEntry` 未取 `payload.id`，為**隨機 id** | — |
| 壓縮邊界 | jsonl `uuid` | ❌ 即時有 `item.id`；歷史 `compacted` 無 id，為**隨機 id** | — |
| 中斷標記 | 即時無（前端合成）；歷史有 jsonl `uuid` | 即時有；歷史為**隨機 id** | 即時無（前端合成）；歷史無 |
| 使用者訊息 | 即時無對應事件；歷史有 jsonl `uuid`（穩定） | 即時 `userMessage` id 與 rollout 不同；歷史為**隨機 id** | 即時無；歷史 `agy_${sessionId}_${lineIndex}_user`（穩定） |
| Cursor | **無契約** | | |

**一致性驗證結果（2026-11-07）**：Claude（`docs/fixtures/claude/multistep.jsonl`）、
Codex（`docs/fixtures/codex/multistep-rollout.jsonl`）與 Antigravity
（`docs/fixtures/antigravity/multistep.*.jsonl`）的助手文字、工具呼叫、thinking、
壓縮邊界、中斷標記與使用者訊息均通過穩定 id 檢查；工具結果經日誌層摺疊後
不再有獨立 id 契約。Cursor 維持「僅空日誌可完整匯入」。

需在進入第一階段前修正，使上表每一格都是「穩定」：

- **工具結果**：依 D3，日誌層一律併入 `tool_use`，對帳忽略歷史中的獨立 `tool_result`。三家不再需要各自對齊這一格。
- **Codex 歷史**：`mapRolloutEntry` 的 `reasoning` 取 `payload.id`（與即時 `item.id` 相同）；其餘沒有 provider id 的條目（`compacted`、使用者訊息、中斷標記）改用 rollout 行號產生決定性 id（`codex_${sessionId}_${lineIndex}`，比照 Antigravity），不再落到 `generateMessageId` 的隨機 id。
- **Codex 使用者訊息的兩種格式**：`fetchHistory` 同時接收 `event_msg/user_message`（`codex-sessions.provider.ts:153`）與 `response_item` 的使用者 `message`（`:167`）。依 `:64` 的註解，新版 rollout 只寫後者；本機 21 個 0.163 rollout 與 repo 的兩份 fixture（0.143、0.163）也確實沒有前者。但較舊的 rollout 若兩種都寫，一則輸入會變成兩則歷史訊息，段內配對會因 h = 2、l = 1 而拒絕配對，日誌為空時則兩則都匯入而重複。防禦性處理：parser 在同一回合內遇到文字相同的 `event_msg` 與 `response_item` 使用者訊息時合併為一則邏輯訊息，id 取 `response_item` 那行的行號 id，另一行的 id 一併記入 `provider_ids`。
- **壓縮邊界與中斷標記**：即時與歷史 id 不同，依「同一段兩側都有即視為已對應」處理（見下方段內配對）。

上表「穩定」與否由 1.x 的一致性測試判定並回填；D7 的分岔偵測與 `provider_ids` 只使用判定為穩定的 id。一致性測試除了「對帳後沒有新增匯入」，還 MUST 斷言「重放後每一則即時使用者訊息都配對到 provider 的訊息」：前者在 h ≠ l 的段落會因「不配對也不匯入」而通過，測不出配對失敗。

- 使用者訊息：**以錨點切段、段內依序對應**。整份會話依序號單純配對（歷史第 k 則 ↔ 日誌第 k 則）的問題是：任一側多一則或少一則，之後全部錯位，而錯位會寫進 `provider_ids` 並被持久化。改為：
  1. **錨點**：已依契約 id 對應的助手文字、工具呼叫與結果。相鄰兩個錨點之間（以及第一個錨點之前、最後一個錨點之後）為一個「段」。
  2. **排除項**：中斷標記（`isInterrupted`，例如 Codex 以 `role: 'user'` 送出的 `<turn_aborted>`）、壓縮邊界、provider 注入的內部文字（Codex 的 AGENTS.md／`<user_instructions>` 等、Claude 的 `isMeta`、本地指令輸出、壓縮摘要）不參與使用者訊息配對。即時與歷史兩側 MUST 共用同一個判定函式（以 `codex-sessions.provider.ts` 現有的 `isInternalCodexUserText`、Claude 的 `isMeta` 判斷為基礎抽出），避免兩側規則漂移。中斷標記與壓縮邊界另以「同一段內兩側都有即視為已對應」處理；歷史側只有、日誌側沒有時才匯入。
  3. **段內配對**：設某段中歷史有 h 則、日誌有 l 則未對應的使用者訊息（`source=live`）：
     - l = 0：視為終端機回合，h 則全部匯入該段。
     - h = l：依順序一一對應；歷史側 id 穩定時才把它記進 `provider_ids`。
     - h ≠ l：該段**不配對也不匯入**，保留日誌原狀，以 `logger.warn` 記錄會話 id、段位置與兩側數量。寧可少顯示一則終端機輸入，也不寫入錯配。
  以順序而非文字比對，避免 `bf2f4eaa` 那類只傳圖片、文字為空的情況配不上。插話（D2 的 `chat-steer`）寫入日誌後與一般使用者訊息同樣參與配對。
- 每個 provider 必須通過「即時重放 → 寫日誌 → 讀歷史 → 對帳後無新增匯入」的一致性測試，才啟用對帳；未通過者（目前 Cursor）在日誌非空時不做匯入，只在日誌為空時做一次完整匯入。已決議接受此限制：Cursor 會話在終端機進行的回合，在補齊 id 契約前不會出現在 UI 的接續對話中；Cursor 的 id 契約另案處理。

### D9. 前端：按 id upsert、按 seq 排序

`useSessionStore` 每個會話只保留一份 `Map<id, message>` 與依 `seq` 排序的陣列：

- WebSocket 收到帶 `seq` 的訊息 → upsert。唯一例外：以伺服器版本取代樂觀使用者訊息時，保留本地的 `images`（D6）。
- 不帶 `seq` 的訊息只處理串流暫存與控制事件，永遠排在尾端。
- `stream_end` 帶 `messageId` 時，暫存以該 id 等待同 id 的定稿 `text` 取代；不帶 `messageId` 時保留暫存，收到下一則帶 `seq` 的助手 `text` 或 `complete` 時清除，MUST NOT 以隨機 id 轉成正式訊息（D3）。
- 收到 `complete(aborted: true)` 時不再在前端合成中斷標記，改由伺服器送出（D3）。
- 讀取 API 的結果 → 整份取代（保留串流暫存）。

移除：`computeMerged`、`interleaveByTimestamp`、`dedupeAdjacentAssistantEchoes`、`isErrorAlreadyShown`、`isTransientRetryRecovered`、使用者文字指紋比對、`refreshFromServer` 的保留白名單、`overlayDefinedFields`、`useChatRealtimeHandlers.ts` 的中斷標記本地合成。錯誤包裝去重（Claude 先以正文送出 API 錯誤、SDK 再拋包裝錯誤）改在伺服器端 Claude runtime 處理，不送重複的那則。

store 的狀態轉移抽成純函式（`applyLogMessage`、`replaceWithFetched`），供 D11 的驗收在 Node 中執行。

### D10. 重新連線依序號補回，並補送串流中的段落

前端重新連線（含整頁重新整理後的首次連線）時，在 `check-session-status` 附上目前持有的最大 `seq`。伺服器依序：

1. 回送該會話 `seq` 更大的日誌訊息（包含斷線期間 `WebSocketWriter.send` 丟掉的訊息）；
2. 若該會話仍在執行且目前段落尚未定稿，把記憶體中累加的段落文字當成一則 `stream_delta` 補送一次；
3. 接續即時流。

前端收到的補送片段與之後的即時片段串接，畫面上立即看到完整的前半段，不會出現「段落缺頭、定稿後才補齊」的空窗。

**為何用記憶體而非資料庫**：段落文字只在執行期間有意義，伺服器行程重啟時執行本身也會中斷，持久化沒有收益；記憶體成本為每個執行中會話一段文字。

**為何在 `LoggingWriter` 累加**：它本來就經手每個 `stream_delta` 與 `stream_end`，不需修改四個 runtime。各 runtime 自己的重新連線機制（Claude 替換底層 socket、Codex／Antigravity 替換 writer）都經過派發處，而派發處在重新連線時傳入的是登記表中原本那個實例（D2），因此新連線取得的是同一個 `LoggingWriter` 實例的累加內容；登記表以會話 id 為鍵，執行結束時移除。

**移除 Antigravity 自己的斷線暫存**：`antigravity-cli.js` 的 `liveWriter.send` 在 `writer.ws.readyState !== OPEN` 時把訊息推進自己的 `pending` 佇列（上限 1000，超過丟最舊），重新連線才補送。這個佇列位於 `LoggingWriter` 之前，造成：斷線期間的持久性訊息不寫入日誌、使用者若不再連回就永遠不會寫入，D10 的補回對 Antigravity 不成立。改為 `liveWriter.send` 一律直接呼叫 `LoggingWriter.send`（先寫日誌，內層 `WebSocketWriter` 在斷線時照常丟棄），並移除 `pending`。斷線期間的非持久性訊息由既有機制取代：持久性訊息由 D10 依 `seq` 補回、串流段落由 D10 補送、待審批項目由 `check-session-status` 的 `getPendingApprovals` 回報、執行是否結束由 `isProcessing` 回報。

### D11. 所見即所得驗收

- **自動**：以 `docs/fixtures` 的錄製事件流（Antigravity stream/transcript、Codex app-server 事件）與假的 CLI 執行檔（沿用 `cursor-cli.test.ts`、`openai-codex.permissions.test.ts` 的手法）驅動真實 runtime 與 `LoggingWriter`，同時把送出的訊息套用到前端純函式 store；執行結束後呼叫讀取 API，斷言兩份序列逐則相同。另以 property 風格的測試，在執行中任意時點插入一次讀取，斷言之後的序列仍相同。
- **手動（發版前）**：沿用本次在瀏覽器使用的方法，每 300ms 取樣偵測重複，並在執行中與結束後各重新整理一次逐則比對，涵蓋 Claude、Codex、Antigravity，以及錯誤、警告、中斷各一例；另在一段長回覆串流到一半時重新整理，確認前半段立即出現。

### D12. 分頁

`GET /sessions/:id/messages?beforeSeq=<n>&limit=<k>`：回傳 `seq < n` 的最後 k 則，依 `seq` 升冪。最終取代現有的 `offset`（以尾端計數的 offset 在中段插入後會位移）。

**過渡期兩種參數並存**：第二階段後端已讀日誌，但前端仍是舊 store、`fetchMore` 仍傳 `offset`；關閉旗標回滾時也要能用 `offset`。因此第二、三階段讀取 API 同時接受 `offset` 與 `beforeSeq`（帶 `beforeSeq` 時以它為準），到收尾階段（移除旗標與舊程式碼時）才移除 `offset`。

### D13. 日誌清理：依時間與總大小，以會話為單位

每日（伺服器啟動時與之後每 24 小時）執行一次清理：

1. **時間**：刪除最後更新時間早於保留期限（預設 90 天）的會話日誌。「最後更新時間」為 `session_messages` 依 `session_id` 彙總的 `MAX(updated_at)`。
2. **大小**：若日誌總大小仍超過上限（預設 1 GB，以 `payload` 長度總和估算），依會話最後更新時間由舊到新刪除，直到低於上限的 90%。

規則：

- **以整個會話為單位刪除**，不刪單則訊息。只刪部分會讓 `seq` 出現斷層、日誌與 provider 歷史的對應錯位；整個會話刪除後日誌為空，下次讀取時依 D7 從 provider 歷史完整匯入，對話內容仍可檢視。
- **不清理收藏（starred）的會話**，與 `session-pin.service.ts` 的「收藏不過期」一致；查詢時 `LEFT JOIN sessions` 排除收藏者。
- **不清理執行中的會話**（以 D10 的會話登記表判斷）。
- 保留天數與大小上限由環境變數設定（`SESSION_LOG_RETENTION_DAYS`、`SESSION_LOG_MAX_BYTES`），設為 0 表示停用該項清理。

為何以 `payload` 長度估算而非資料庫檔案大小：SQLite 刪除後檔案不會自動縮小，以檔案大小判斷會持續觸發清理；`payload` 總和反映實際資料量，查詢成本低（可維護一個按會話彙總的大小欄位）。

### D14. 刪除會話與專案時同步刪除日誌；啟用 WAL

- 刪除單一會話時呼叫 `deleteBySession`。
- **硬刪除專案**走的是 `sessionsDb.deleteSessionsByProjectPath`（`sessions.db.ts:214`），直接執行 `DELETE FROM sessions WHERE project_path = ?`，不會逐一經過會話刪除流程。須在同一交易中先刪除這些會話的 `session_messages`（`DELETE FROM session_messages WHERE session_id IN (SELECT session_id FROM sessions WHERE project_path = ?)`），再刪 `sessions`，否則會留下孤兒日誌。
- 資料庫目前未設定 `journal_mode`（`server/modules/database` 中沒有此設定）。在 `connection.ts` 建立連線時執行 `PRAGMA journal_mode = WAL`，避免讀取 API 的對帳與送出路徑的寫入互相鎖住。

## Risks / Trade-offs

- [對帳錯配：id 契約不完整導致重複或遺漏] → D8 的逐 provider 一致性測試作為啟用閘門；Cursor 暫不對帳；對帳結果寫回後可稽核（`source=import` 與 `provider_ids`）。
- [錯配被持久化，重新整理也無法恢復] → 執行中只補齊不匯入（D7）；使用者訊息段內數量不符時不配對（D8）；提供整會話重建作為修復入口（D7）。
- [送出路徑繞過日誌] → 派發處統一經 `sendToClient`、重新連線沿用登記的實例、移除 Antigravity 的斷線暫存（D2、D10）；以「每則持久性訊息都帶 `seq`」的不變量測試防止回歸。
- [provider 端 rewind／fork／回滾使日誌與 CLI 長期不一致] → 偵測已對應訊息從 provider 歷史消失時整會話重建（D7）；代價是自產訊息遺失。
- [多副本部署下序號衝突] → 以單一副本為前提（D4），實作前確認。
- [歷史側 id 不穩定導致反覆匯入或誤判分岔] → D8 逐種類契約表，Codex 歷史改用 `payload.id` 與 rollout 行號產生決定性 id；`tool_result` 統一併入 `tool_use`（D3）；分岔偵測與 `provider_ids` 只用判定為穩定的 id（D7）。
- [Antigravity 臨時 UUID 寫入不存在的會話] → 新會話在 `session_created` 前不採信訊息自帶的 `sessionId`，執行結束仍未確定則不入日誌（D5）。
- [儲存成本：工具輸出很大] → `payload` 單則上限 512 KB，超出截斷並標記 `truncated`；完整內容在讀取時由 provider 歷史補齊（不寫回超出部分）。總量依 D13 清理。刪除會話與硬刪除專案時一併刪除日誌（D14）。
- [清理後失去自產訊息] → 被清理的會話再次打開時由 provider 歷史重新匯入，對話內容仍在，但當時的錯誤、警告、中斷標記不會回來；收藏的會話與執行中的會話不清理。
- [記憶體中的段落與實際送出不同步，例如重新連線時恰好收到 `stream_end`] → 補送與後續訊息都經同一個 `LoggingWriter` 依序處理；段落定稿時先清除累加內容再送出定稿訊息，前端以同 id 的定稿 `text` 取代暫存，即使補送與定稿相鄰也不會重複。
- [伺服器行程重啟時執行中的段落遺失] → 執行本身也隨行程中斷，與現況相同；已定稿訊息都在日誌中。
- [寫入延遲加在送出路徑上] → better-sqlite3 同步寫入，單則微秒級；`stream_delta` 不寫入，高頻路徑不受影響。以 WAL 模式避免讀寫互鎖。
- [既有會話第一次讀取時大量匯入] → 匯入在讀取時進行、與檔案 mtime 快取搭配；只在第一次付出成本。大型會話的首次讀取可能變慢，需量測。
- [終端機與 UI 交替寫同一會話時中段插入過多，`seq` 精度耗盡] → REAL 中點插入在同一間隙約可分 50 次；超過時對該會話整體重新編號（離線、單一交易）。
- [遷移期間兩套讀取路徑並存] → 以設定旗標 `SESSION_MESSAGE_LOG_ENABLED` 控制（預設開啟，設為 `0`/`false`/`off` 可立即回退至舊路徑）。
- [runtime 依 writer 標記決定送字串，繞過日誌] → `LoggingWriter` 固定宣告 `isWebSocketWriter`，收到字串時先解析；驗收以真實 runtime 驅動（D2）。
- [客戶端以 `clientId` 覆寫既有訊息] → 驗證 UUID、伺服器加 `user:` 前綴、使用者訊息只 insert-if-absent（D6）。
- [圖片縮圖重新整理後消失] → 前端在記憶體保留本地 `images`，重新整理後與現況相同；持久化另案（D6）。

## Migration Plan

0. **前置閘門：id 契約**。D8 契約表中每一格都必須是「穩定」才進入第一階段：Claude 由 tasks 1.3 驗證；Codex 須先完成歷史解析的決定性 id 修正（reasoning、壓縮邊界、使用者訊息、中斷標記），再以 1.2 驗證。Claude 是使用量最大、目前最穩定的 provider；若它無法建立即時／歷史 id 一致，就只能「日誌為空時匯入一次」，終端機接續回合會從 UI 消失，等於讓最穩定的路徑退步。修不好則回到方案取捨重新評估，不帶著缺口進入實作。同時確認部署為單一副本（D4）。
1. **第一階段：只寫不讀**。新增資料表與 `LoggingWriter`，所有持久性訊息寫入日誌並帶 `seq` 送出；前端忽略 `seq`。新增診斷端點比對日誌與舊 `fetchHistory` 的差異，在開發機累積資料，驗證寫入正確性。
2. **第二階段：伺服器讀日誌**。讀取 API 在旗標開啟時改走 D7 的對帳流程；前端仍用舊 store。此時「重新整理後」的結果已包含自產訊息與穩定順序。
3. **第三階段：前端切換**。store 改為 D9 的 upsert／排序，移除拼接啟發式；啟用 D10 補回。D11 自動驗收納入 `npm test`。
4. **收尾**：驗收穩定後移除旗標與舊合併程式碼。

**回滾**：任一階段關閉旗標即回到舊讀取路徑；日誌資料表保留不影響舊路徑。第三階段的前端變更以同一旗標控制（伺服器在 `/api/config` 回報旗標狀態）。

## Open Questions

已決議（2026-11-06）：

1. 採用方案 A（完整事件日誌），三個階段依序實作。
2. 單則 `payload` 上限 512 KB；日誌依時間與總大小清理（D13），預設值如 D13 所列，可透過設定調整。
3. 接受 Cursor 在補齊 id 契約前，終端機回合不出現在 UI 的接續對話中（D8）；Cursor 的 id 契約另案處理。

review 後補充（2026-11-06）：

4. 派發處所有持久性訊息統一經日誌送出，重新連線沿用同一個 `LoggingWriter` 實例，移除 Antigravity 的斷線暫存（D2、D10）。
5. 使用者訊息改為錨點切段、段內依序對應，數量不符時不配對（D8）。
6. 執行中只補齊不匯入；偵測 provider 端刪減時整會話重建，接受自產訊息遺失（D7）。
7. Claude id 契約驗證作為進入第一階段的閘門；部署須為單一副本（Migration Plan 第 0 步、D4）。

PR #10 review 後補充（2026-11-06，已對照程式碼核對）：

8. id 契約改為逐訊息種類定義；Codex 歷史改用 `payload.id` 與 rollout 行號產生決定性 id；分岔偵測只用穩定 id（D7、D8）。
9. `tool_result` 在日誌層一律併入同 `toolId` 的 `tool_use`（D3）。
10. 中斷標記由伺服器產生並寫入日誌，移除前端合成（D3、D9）。
11. 不帶 `messageId` 的 `stream_end` 不轉成隨機 id 訊息（預防性；Claude 目前未開串流，不觸發）（D3、D9）。
12. 新會話在 `session_created` 前不採信訊息自帶的 `sessionId`；先送 `session_created` 再送暫存訊息（D5）。
13. 使用者訊息沿用 `clientId` 欄位名；先記錄使用者訊息再送並行終端警告（D6）。
14. 第二、三階段同時接受 `offset` 與 `beforeSeq`，收尾時才移除 `offset`（D12）。
15. 硬刪除專案同步刪除日誌；`connection.ts` 啟用 WAL（D14）。

PR #10 第二輪 review 後補充（2026-11-06，已對照程式碼核對）：

16. `LoggingWriter` 固定宣告 `isWebSocketWriter = true`，收到字串時先解析；Codex、Antigravity 驗收以真實 runtime 驅動（D2）。
17. `/api/agent` 可接續既有會話，改為一律包裝 `LoggingWriter`，撤回先前「不包裝」的決議（D2）。
18. Codex parser 合併同一回合文字相同的 `event_msg`／`response_item` 使用者訊息（防禦性；0.163 未重現）；一致性測試斷言每則即時使用者訊息都配對成功（D8）。
19. `clientId` 驗證為 UUID、日誌 id 加 `user:` 前綴、使用者訊息只 insert-if-absent（D6）。
20. `seq` 規則改為「即時寫入大於目前最大值；匯入可插入既有區間」，`seq` 只定義顯示順序（D4）。
21. 前端以同 id 取代使用者訊息時保留本地 `images`；接受重新整理後縮圖消失，持久化另案（D6）。

尚無未決問題。D13 的預設值（90 天、1 GB）為起始值，上線後依實際用量調整。
