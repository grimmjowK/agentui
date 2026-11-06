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

SQLite（better-sqlite3）已用於 sessions／projects 索引；資料庫遷移集中在 `server/modules/database/migrations.ts`。UI 發起的聊天執行都經過 `chat-websocket.service.ts` 的 `runtime.start` / `runtime.reconnect`。另有外部 REST API（`/api/agent`，`routes/agent.js`）供 CI、n8n 等以 API key 呼叫，每次都建立全新會話，結果以 SSE 或一次性回應回給呼叫端。

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
- 外部 REST API（`/api/agent`）的執行不寫入日誌（見 D2）。

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

**外部 REST API 不包裝**：`/api/agent` 每次呼叫都建立全新會話、沒有接續參數，結果（含錯誤）直接回給呼叫端。這類會話之後在 UI 第一次打開時日誌為空，會依 D7 從 provider 歷史完整匯入，所以不寫日誌也不影響在 UI 中檢視；唯一差別是該次 API 執行中的自產錯誤不出現在 UI 歷史中。少包裝一處，也避免 SSE／一次性回應兩種 writer 的額外分支。

**歸屬以訊息自身的 `sessionId` 為準**，不用 `writer.sessionId`：一條 WebSocket 連線共用一個 writer，可能先後承載多個會話。

### D3. 持久性訊息的範圍

| 寫入日誌 | 不寫入（只即時送出） |
|---|---|
| `text`（使用者、助手）、`thinking`、`tool_use`、`tool_result`、`error`、`task_notification`（`warning`/`error`）、中斷標記（`isInterrupted`）、壓縮邊界 | `stream_delta`、`stream_end`、`status`、`session_created`、`complete`、`permission_request` / `permission_cancelled`、`task_notification`（`info`） |

串流文字在 `stream_end` 時以 `messageId` 定稿，隨後同 id 的 `text` 寫入日誌（沿用 `unify-agent-rendering-and-provider-cleanup` 的 id 契約）。串流中的半段文字不寫入資料庫：每個 delta 寫一次的寫入量過大。改由 `LoggingWriter` 在記憶體中累加該會話目前段落已送出的文字，於重新連線時補送（D10），段落定稿或執行結束即清除。

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

- 新訊息：`seq = floor(max(seq)) + 1`。better-sqlite3 是同步呼叫，在單一行程內與寫入同交易即為原子操作。
- 同 id 再次送出（工具從 started 到 completed、`text` 覆蓋串流定稿）：就地更新 `payload`、保留 `seq`。欄位合併規則：新值非 `undefined`/`null` 才覆蓋（即時流的後續事件比前一個事件完整，與 D7 的「歷史補齊」方向不同）。
- 送出給前端的訊息一律帶 `seq`；更新也帶原 `seq`，前端按 id upsert。

`seq` 用 REAL 是為了 D7 的中段插入（取前後兩則的中點）；一般追加維持整數。

### D5. 會話 id 確定前的暫存

新會話在 `session_created` 之前，訊息的 `sessionId` 為 null（Claude 在第一個 SDK 訊息前、Codex 在 `thread/start` 前、使用者訊息在派發時）。`LoggingWriter` 為每次執行（每次 `runtime.start` 呼叫建立一個實例）保留暫存佇列，收到 `session_created` 或 `setSessionId` 時依原順序寫入並指派序號，再送出。因為一次執行對應一個 `LoggingWriter` 實例，同一連線上並行的兩個新會話不會互相混入。

### D6. 使用者訊息由伺服器記錄

目前使用者訊息只存在於前端樂觀訊息與 provider 歷史。改為：前端送 `chat-command` 時附 `clientMessageId`（`local_<uuid>`），派發處以該 id 寫入一則使用者 `text`（含圖片縮圖的中繼資料，不含 base64 本體），送回帶 `seq` 的版本，前端以同 id 取代樂觀訊息。圖片本體不入日誌，只存檔名與尺寸；重新整理後的縮圖延續目前行為（顯示路徑說明）。

### D7. 讀取時的匯入與補齊（伺服器端）

讀取 `/sessions/:id/messages` 時：

1. 讀日誌。
2. 讀 provider 歷史（依檔案 mtime 快取）。
3. 對帳，依 provider 歷史順序處理每則訊息：
   - **已在日誌中**（`id` 或 `provider_ids` 命中）：用歷史補齊日誌中缺少或不完整的欄位，寫回日誌（例：Antigravity `toolInput` 的完整 diff、Codex 的工具輸出）。歷史對「內容欄位」具權威；日誌獨有的欄位（`seq`、自產訊息）不動。
   - **不在日誌中**：視為匯入訊息。若它之後沒有任何已對應的訊息（尾端，例如在終端機進行的新回合，或日誌為空的既有會話），追加到尾端；若位於兩則已對應訊息之間（例如 Codex 注入的 AGENTS.md 使用者訊息），以前後兩則的 `seq` 中點插入。
4. 回傳日誌（依 `seq`）。

只在伺服器端合併，且寫回日誌，所以同一次結果之後每次讀取都相同。

### D8. id 契約是對帳的前提；使用者訊息以回合內順序對應

對帳依賴「同一則訊息在即時與歷史中 id 相同」。現況：

| provider | 助手文字／工具 | 使用者訊息 |
|---|---|---|
| Claude | SDK `uuid` = jsonl `uuid`（需以一致性測試確認，含 `tool_result`） | 即時無對應事件 |
| Codex | `item.id` = rollout `payload.id` / `call_id` | 即時 `userMessage` id 與 rollout id **不同** |
| Antigravity | `step_index` 生成的 id | 即時無對應事件 |
| Cursor | **無契約** | 無 |

- 使用者訊息：歷史中第 k 則尚未對應的使用者訊息，對應日誌中同一位置之後第 k 則尚未對應的使用者訊息（`source=live`），把 provider id 記進 `provider_ids`。以順序而非文字比對，避免 `bf2f4eaa` 那類只傳圖片、文字為空的情況配不上。
- 每個 provider 必須通過「即時重放 → 寫日誌 → 讀歷史 → 對帳後無新增匯入」的一致性測試，才啟用對帳；未通過者（目前 Cursor）在日誌非空時不做匯入，只在日誌為空時做一次完整匯入。已決議接受此限制：Cursor 會話在終端機進行的回合，在補齊 id 契約前不會出現在 UI 的接續對話中；Cursor 的 id 契約另案處理。

### D9. 前端：按 id upsert、按 seq 排序

`useSessionStore` 每個會話只保留一份 `Map<id, message>` 與依 `seq` 排序的陣列：

- WebSocket 收到帶 `seq` 的訊息 → upsert。
- 不帶 `seq` 的訊息只處理串流暫存與控制事件，永遠排在尾端。
- 讀取 API 的結果 → 整份取代（保留串流暫存）。

移除：`computeMerged`、`interleaveByTimestamp`、`dedupeAdjacentAssistantEchoes`、`isErrorAlreadyShown`、`isTransientRetryRecovered`、使用者文字指紋比對、`refreshFromServer` 的保留白名單、`overlayDefinedFields`。錯誤包裝去重（Claude 先以正文送出 API 錯誤、SDK 再拋包裝錯誤）改在伺服器端 Claude runtime 處理，不送重複的那則。

store 的狀態轉移抽成純函式（`applyLogMessage`、`replaceWithFetched`），供 D11 的驗收在 Node 中執行。

### D10. 重新連線依序號補回，並補送串流中的段落

前端重新連線（含整頁重新整理後的首次連線）時，在 `check-session-status` 附上目前持有的最大 `seq`。伺服器依序：

1. 回送該會話 `seq` 更大的日誌訊息（包含斷線期間 `WebSocketWriter.send` 丟掉的訊息）；
2. 若該會話仍在執行且目前段落尚未定稿，把記憶體中累加的段落文字當成一則 `stream_delta` 補送一次；
3. 接續即時流。

前端收到的補送片段與之後的即時片段串接，畫面上立即看到完整的前半段，不會出現「段落缺頭、定稿後才補齊」的空窗。

**為何用記憶體而非資料庫**：段落文字只在執行期間有意義，伺服器行程重啟時執行本身也會中斷，持久化沒有收益；記憶體成本為每個執行中會話一段文字。

**為何在 `LoggingWriter` 累加**：它本來就經手每個 `stream_delta` 與 `stream_end`，不需修改四個 runtime。各 runtime 自己的重新連線機制（Claude 替換底層 socket、Codex／Antigravity 替換 writer）都經過派發處，因此新連線取得的是同一個 `LoggingWriter` 實例的累加內容；實作時須讓 `LoggingWriter` 以會話 id 可被查得（例如以會話 id 為鍵的登記表，執行結束時移除）。

### D11. 所見即所得驗收

- **自動**：以 `docs/fixtures` 的錄製事件流（Antigravity stream/transcript、Codex app-server 事件）與假的 CLI 執行檔（沿用 `cursor-cli.test.ts`、`openai-codex.permissions.test.ts` 的手法）驅動真實 runtime 與 `LoggingWriter`，同時把送出的訊息套用到前端純函式 store；執行結束後呼叫讀取 API，斷言兩份序列逐則相同。另以 property 風格的測試，在執行中任意時點插入一次讀取，斷言之後的序列仍相同。
- **手動（發版前）**：沿用本次在瀏覽器使用的方法，每 300ms 取樣偵測重複，並在執行中與結束後各重新整理一次逐則比對，涵蓋 Claude、Codex、Antigravity，以及錯誤、警告、中斷各一例；另在一段長回覆串流到一半時重新整理，確認前半段立即出現。

### D12. 分頁

`GET /sessions/:id/messages?beforeSeq=<n>&limit=<k>`：回傳 `seq < n` 的最後 k 則，依 `seq` 升冪。取代現有的 `offset`（以尾端計數的 offset 在中段插入後會位移）。

### D13. 日誌清理：依時間與總大小，以會話為單位

每日（伺服器啟動時與之後每 24 小時）執行一次清理：

1. **時間**：刪除最後更新時間早於保留期限（預設 90 天）的會話日誌。
2. **大小**：若日誌總大小仍超過上限（預設 1 GB，以 `payload` 長度總和估算），依會話最後更新時間由舊到新刪除，直到低於上限的 90%。

規則：

- **以整個會話為單位刪除**，不刪單則訊息。只刪部分會讓 `seq` 出現斷層、日誌與 provider 歷史的對應錯位；整個會話刪除後日誌為空，下次讀取時依 D7 從 provider 歷史完整匯入，對話內容仍可檢視。
- **不清理收藏（starred）的會話**，與 `session-pin.service.ts` 的「收藏不過期」一致。
- **不清理執行中的會話**（以 D10 的會話登記表判斷）。
- 保留天數與大小上限由環境變數設定（`SESSION_LOG_RETENTION_DAYS`、`SESSION_LOG_MAX_BYTES`），設為 0 表示停用該項清理。

為何以 `payload` 長度估算而非資料庫檔案大小：SQLite 刪除後檔案不會自動縮小，以檔案大小判斷會持續觸發清理；`payload` 總和反映實際資料量，查詢成本低（可維護一個按會話彙總的大小欄位）。

## Risks / Trade-offs

- [對帳錯配：id 契約不完整導致重複或遺漏] → D8 的逐 provider 一致性測試作為啟用閘門；Cursor 暫不對帳；對帳結果寫回後可稽核（`source=import` 與 `provider_ids`）。
- [儲存成本：工具輸出很大] → `payload` 單則上限 512 KB，超出截斷並標記 `truncated`；完整內容在讀取時由 provider 歷史補齊（不寫回超出部分）。總量依 D13 清理。刪除／硬刪會話時一併刪除日誌。
- [清理後失去自產訊息] → 被清理的會話再次打開時由 provider 歷史重新匯入，對話內容仍在，但當時的錯誤、警告、中斷標記不會回來；收藏的會話與執行中的會話不清理。
- [記憶體中的段落與實際送出不同步，例如重新連線時恰好收到 `stream_end`] → 補送與後續訊息都經同一個 `LoggingWriter` 依序處理；段落定稿時先清除累加內容再送出定稿訊息，前端以同 id 的定稿 `text` 取代暫存，即使補送與定稿相鄰也不會重複。
- [伺服器行程重啟時執行中的段落遺失] → 執行本身也隨行程中斷，與現況相同；已定稿訊息都在日誌中。
- [寫入延遲加在送出路徑上] → better-sqlite3 同步寫入，單則微秒級；`stream_delta` 不寫入，高頻路徑不受影響。以 WAL 模式避免讀寫互鎖。
- [既有會話第一次讀取時大量匯入] → 匯入在讀取時進行、與檔案 mtime 快取搭配；只在第一次付出成本。大型會話的首次讀取可能變慢，需量測。
- [終端機與 UI 交替寫同一會話時中段插入過多，`seq` 精度耗盡] → REAL 中點插入在同一間隙約可分 50 次；超過時對該會話整體重新編號（離線、單一交易）。
- [遷移期間兩套讀取路徑並存] → 以設定旗標切換（見 Migration Plan），驗收通過前預設維持舊路徑。

## Migration Plan

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

尚無未決問題。D13 的預設值（90 天、1 GB）為起始值，上線後依實際用量調整。
