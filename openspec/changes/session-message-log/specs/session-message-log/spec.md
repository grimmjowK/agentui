## ADDED Requirements

### Requirement: 持久性訊息在送出前寫入對話日誌
系統 SHALL 在把下列種類的 `NormalizedMessage` 送往前端之前，先寫入伺服器端的對話日誌（`session_messages`）：`text`（使用者與助手）、`thinking`、`tool_use`、`tool_result`、`error`、`status` 為 `warning` 或 `error` 的 `task_notification`、帶 `isInterrupted` 的訊息、壓縮邊界。`stream_delta`、`stream_end`、`status`、`session_created`、`complete`、`permission_request`、`permission_cancelled` 與 `status` 為 `info` 的 `task_notification` MUST NOT 寫入日誌。寫入 MUST 發生在聊天派發處的日誌層（`LoggingWriter` 與派發處的 `sendToClient`）中，涵蓋聊天 WebSocket 上所有會送出持久性訊息的路徑：`runtime.start`、`runtime.reconnect` 與 `runtime.abort` 收到的 writer，以及派發處自行送出的訊息（例如審批失敗的 `task_notification`）。runtime MUST NOT 在日誌層之前自行暫存或丟棄持久性訊息。外部 REST API（`/api/agent`）的執行 MUST NOT 寫入日誌；這類會話在 UI 第一次讀取時依匯入規則從 provider 歷史取得。

#### Scenario: 每則持久性訊息都帶序號
- **WHEN** 一輪執行中依序發生工具呼叫、審批失敗、使用者插話、中斷，期間前端重新連線一次
- **THEN** 前端收到的每一則持久性種類訊息都帶 `seq`，且都已寫入日誌

#### Scenario: Antigravity 斷線期間的訊息
- **WHEN** Antigravity 執行中 WebSocket 斷線，期間 runtime 送出一則 `tool_result`，之後使用者不再連回
- **THEN** 該 `tool_result` 已寫入日誌；使用者之後打開該會話時看得到它

#### Scenario: 錯誤訊息被持久化
- **WHEN** Antigravity 執行失敗，runtime 送出一則 `kind: 'error'` 的訊息
- **THEN** 該訊息先寫入日誌並取得序號，再送往前端；之後讀取該會話的訊息時包含這則錯誤

#### Scenario: 串流增量不寫入
- **WHEN** runtime 連續送出 100 則 `stream_delta`
- **THEN** 日誌中不新增任何資料列

#### Scenario: 外部 API 的執行
- **WHEN** CI 透過 `/api/agent` 以 API key 建立一個新會話並執行完畢，之後使用者在 UI 打開該會話
- **THEN** 執行期間日誌中沒有該會話的資料列；UI 第一次讀取時，provider 歷史完整匯入日誌並顯示

#### Scenario: info 通知不寫入
- **WHEN** Codex runtime 送出 `status: 'info'` 的 `task_notification`（版本與執行檔路徑）
- **THEN** 日誌中不新增資料列

### Requirement: 工具結果在日誌中併入對應的工具呼叫
日誌層收到帶 `toolId` 的 `tool_result` 時，系統 SHALL 把其內容（`content`、`isError`、`toolUseResult`、`subagentTools`）寫入同會話中 `toolId` 相同的 `tool_use` 資料列的 `toolResult`，保留該列的 `seq`，並把更新後的 `tool_use` 送往前端；MUST NOT 為此新增資料列。找不到對應的 `tool_use` 時，MUST 以 `${toolId}:result` 為 id 獨立寫入。對帳時 MUST 忽略 provider 歷史中的獨立 `tool_result` 訊息，結果內容只經由歷史中 `tool_use.toolResult` 補齊。

#### Scenario: 三種即時形態寫入後一致
- **WHEN** Codex 以同 id 的 `tool_use` 帶 `toolResult` 送出結果、Antigravity 送出 id 為 `agy_tool_2:result` 的獨立 `tool_result`、Claude 送出 id 為 `${uuid}_tr_toolu_1` 的獨立 `tool_result`
- **THEN** 三者在日誌中都只有一列對應的 `tool_use`，其 `toolResult` 為結果內容，`seq` 為工具呼叫首次寫入時的值

#### Scenario: Codex 歷史中的獨立工具結果
- **WHEN** Codex rollout 的 `function_call_output` 被解析為一則沒有固定 id 的 `tool_result`，該會話被連續讀取兩次
- **THEN** 兩次讀取都不新增任何資料列，工具結果只出現在對應 `tool_use` 的 `toolResult`

### Requirement: 中斷標記由伺服器產生
日誌層收到 `kind: 'complete'` 且 `aborted: true`、而該次執行尚未送出過帶 `isInterrupted` 的訊息時，系統 SHALL 先寫入並送出一則 `role: 'user'`、`content: '<turn_aborted>'`、`isInterrupted: true`、id 為 `${sessionId}:interrupted:${runId}` 的訊息，再送出 `complete`。前端 MUST NOT 自行合成中斷標記。

#### Scenario: Claude 中斷後重新整理
- **WHEN** Claude 執行中使用者按下中斷，伺服器送出 `complete(aborted: true)`，之後使用者重新整理頁面
- **THEN** 中斷前後畫面上都有一則中斷標記，位置相同，且來自日誌

#### Scenario: Codex 不重複產生
- **WHEN** Codex runtime 已在中斷時送出帶 `isInterrupted` 的 `<turn_aborted>`，隨後送出 `complete(aborted: true)`
- **THEN** 日誌層不再額外產生中斷標記，該回合只有一則

### Requirement: 伺服器指派會話內唯一且穩定的序號
系統 SHALL 為每則新寫入的訊息指派該會話內唯一的序號 `seq`，新訊息的 `seq` MUST 大於該會話所有既有訊息的 `seq`。同一會話內以相同 `id` 再次寫入時，系統 MUST 就地更新內容並保留原 `seq`，且只以新值中非 `undefined`／`null` 的欄位覆蓋。送往前端的持久性訊息（新增與更新）MUST 帶上 `seq`。

#### Scenario: 工具從開始到完成
- **WHEN** Codex 對同一工具先送出 `item/started` 映射的 `tool_use`（id `call_1`），再送出 `item/completed` 映射的同 id `tool_use`（含 `toolResult`）
- **THEN** 日誌中只有一列 `call_1`，`seq` 為第一次寫入時指派的值，內容包含 `toolResult`；兩次送往前端的訊息帶相同 `seq`

#### Scenario: 序號遞增
- **WHEN** 同一會話依序寫入訊息 A、B、C
- **THEN** `seq(A) < seq(B) < seq(C)`

### Requirement: 會話 id 確定前的訊息依序暫存
系統 SHALL 為每次執行保留暫存佇列，存放 `sessionId` 尚未確定時送出的持久性訊息；在該次執行收到 `session_created` 或 writer 被設定會話 id 時，MUST 依原順序寫入日誌、指派序號。對前端 MUST 先送出 `session_created`，再送出這些暫存訊息。兩個在同一連線上並行的新會話 MUST NOT 互相混入對方的暫存訊息。新會話（啟動時未帶 `sessionId`）在收到 `session_created` 或被設定會話 id 之前，系統 MUST NOT 採信訊息自帶的 `sessionId`；執行結束時仍未確定會話 id 者，暫存訊息 MUST 照常送往前端，但 MUST NOT 寫入日誌。

#### Scenario: 新會話的第一則使用者訊息
- **WHEN** 使用者在新會話送出第一則訊息，派發處記錄使用者訊息時尚無會話 id，隨後 runtime 送出 `session_created`
- **THEN** 使用者訊息以 `seq` 最小的位置寫入該新會話的日誌，並早於任何助手訊息；前端先收到 `session_created`，再收到帶 `seq` 的使用者訊息

#### Scenario: Antigravity 啟動前失敗
- **WHEN** 使用者在新會話使用 Antigravity，但 CLI 未安裝，runtime 以臨時 UUID 為 `sessionId` 送出一則錯誤後結束，從未送出 `session_created`
- **THEN** 前端照常收到該錯誤；日誌中沒有任何以該臨時 UUID 為 `session_id` 的資料列

### Requirement: 使用者訊息由伺服器以客戶端 id 記錄
系統 SHALL 在收到 `chat-command` 時，以及 `chat-steer` 插話被 runtime 接受時，以請求中的 `clientId` 為 id 寫入一則使用者 `text` 訊息並送回前端（帶 `seq`）。被拒絕的插話 MUST NOT 寫入。圖片 MUST 只記錄檔名與尺寸等中繼資料，MUST NOT 把 base64 本體寫入日誌。處理 `chat-command` 時，系統 MUST 先記錄使用者訊息，再送出其他訊息（包括並行終端警告），最後啟動 runtime。

#### Scenario: 並行終端警告排在使用者訊息之後
- **WHEN** 使用者在一個已有終端機進行中的會話送出訊息，派發處需送出並行終端警告
- **THEN** 日誌中使用者訊息的 `seq` 小於該警告的 `seq`

#### Scenario: 執行中插話
- **WHEN** Codex 執行中使用者送出插話，`clientId` 為 `local_steer1`，runtime 回覆接受
- **THEN** 日誌中出現 id 為 `local_steer1` 的使用者訊息，`seq` 位於插話當下已寫入的訊息之後

#### Scenario: 只傳圖片的訊息
- **WHEN** 使用者送出不含文字、附一張圖片的訊息，`clientId` 為 `local_abc`
- **THEN** 日誌中出現 id 為 `local_abc` 的使用者訊息，包含圖片中繼資料但不含 base64 內容；前端收到帶 `seq` 的同 id 訊息

### Requirement: 讀取時在伺服器端匯入與補齊 provider 歷史
讀取會話訊息時，系統 SHALL 依 provider 歷史的順序與日誌對帳：歷史訊息的 id（或已記錄的 provider id）已在日誌中時，MUST 以歷史中的內容欄位補齊日誌並寫回，且 MUST NOT 改變其 `seq`；歷史訊息不在日誌中且位於所有已對應訊息之後時，MUST 追加到日誌尾端；位於兩則已對應訊息之間時，MUST 以前後兩者 `seq` 之間的值插入。對帳結果寫回日誌後，相同輸入的再次讀取 MUST 產生相同結果。

使用者訊息 MUST 以錨點切段、段內依序對應，而非文字比對，也 MUST NOT 跨整份會話依序號對應：以依契約 id 已對應的助手文字、工具呼叫與結果為錨點，相鄰錨點之間為一段；中斷標記、provider 注入的內部文字、Claude `isMeta`、本地指令輸出與壓縮摘要不參與配對，且即時與歷史兩側 MUST 以同一判定函式排除。設某段歷史有 h 則、日誌有 l 則未對應的使用者訊息：l 為 0 時 MUST 將 h 則全部匯入該段；h 等於 l 時 MUST 依順序一一對應，且只在歷史側 id 為穩定 id 時記入 provider id；h 不等於 l 時 MUST NOT 對應也 MUST NOT 匯入該段的使用者訊息，並記錄警告。中斷標記與壓縮邊界不參與使用者訊息配對，在同一段兩側皆有時 MUST 視為已對應。

#### Scenario: 補齊完整 diff
- **WHEN** 日誌中 Antigravity 工具 `agy_tool_2` 的 `toolInput.content` 為空字串（即時摘要），歷史中同 id 的 `content` 為完整檔案內容
- **THEN** 讀取結果中 `agy_tool_2` 的 `content` 為完整內容，`seq` 不變，且日誌已更新

#### Scenario: 終端機進行的新回合
- **WHEN** 使用者在終端機對同一會話接續一回合，歷史中出現日誌沒有的使用者訊息與助手回覆，且都位於日誌最後一則已對應訊息之後
- **THEN** 這些訊息依歷史順序追加到日誌尾端，`source` 為 `import`

#### Scenario: 歷史獨有的中段訊息
- **WHEN** Codex 歷史中有一則日誌沒有的注入使用者訊息，位於兩則已對應訊息之間
- **THEN** 該訊息以兩者之間的 `seq` 插入，讀取結果中位於兩者之間

#### Scenario: 使用者訊息依順序對應
- **WHEN** 日誌中有一則 id 為 `local_abc` 的使用者訊息，歷史中同一回合的使用者訊息 id 為 `msg_123`
- **THEN** 兩者對應為同一則，`msg_123` 記入 `local_abc` 的 provider id，讀取結果中只有一則使用者訊息

#### Scenario: 段內數量不符時不配對
- **WHEN** 某段中日誌有 1 則未對應的使用者訊息，歷史有 2 則
- **THEN** 該段的使用者訊息不對應、不匯入，日誌維持原狀，並記錄一則包含會話 id 與兩側數量的警告；其他段的對帳不受影響

#### Scenario: 中斷標記不造成錯位
- **WHEN** Codex 會話中某回合被中斷，日誌與歷史在該段都有一則 `<turn_aborted>` 中斷標記，下一回合各有一則使用者訊息
- **THEN** 中斷標記視為已對應，下一回合的使用者訊息正確一一對應，讀取結果不出現重複

### Requirement: 執行中的會話只補齊不匯入
讀取正在執行中的會話時，系統 SHALL 只以 provider 歷史補齊日誌中已對應訊息的內容欄位，MUST NOT 匯入任何日誌中沒有的歷史訊息（含尾端、中段與使用者訊息）。執行結束後的讀取 MUST 進行完整對帳，且結果 MUST 與「執行中從未被讀取」時相同。

#### Scenario: 執行中讀取
- **WHEN** 一次執行進行中，provider 歷史已寫入一則即時流尚未送出的助手訊息，前端此時讀取會話訊息
- **THEN** 該訊息不被匯入；之後即時流以契約 id 送出該訊息時，日誌中只有一列

### Requirement: provider 端刪減或分岔時重建會話日誌
對帳時若日誌中曾經對應過的訊息不存在於非空的 provider 歷史中，系統 SHALL 判定該會話已分岔，並在單一交易中刪除該會話的日誌、依「日誌為空」的規則從 provider 歷史完整匯入，同時記錄警告（會話 id 與觸發原因）。「曾經對應過」MUST 只採計穩定的 id（日誌列的 `id` 為穩定契約 id，或 `provider_ids` 中記錄的穩定 provider id）；每次讀取都會改變的 id MUST NOT 參與分岔判斷。系統 MUST 另提供手動觸發單一會話重建的管理端點。重建後應用自產訊息（錯誤、警告、中斷標記）不保留。

#### Scenario: 反覆讀取不誤判分岔
- **WHEN** 一個已結束的 Codex 會話在 provider 歷史不變的情況下被連續讀取十次
- **THEN** 十次都不觸發重建，日誌資料列數與內容不變

#### Scenario: 終端機 rewind
- **WHEN** 使用者在終端機對 Claude 會話執行 `/rewind`，provider 歷史截短，日誌中已對應的最後三則訊息在歷史中已不存在
- **THEN** 下次讀取時該會話日誌被重建，讀取結果與截短後的 provider 歷史一致，並記錄一則重建警告

#### Scenario: 手動重建
- **WHEN** 管理者對某會話呼叫重建端點
- **THEN** 該會話日誌被刪除並從 provider 歷史完整匯入，回傳重建後的訊息數量

### Requirement: 對帳以 provider 的 id 契約一致性為啟用前提
系統 SHALL 只對通過「即時重放寫入日誌後，以 provider 歷史對帳不產生任何新匯入」一致性測試的 provider 啟用中段與尾端匯入。未通過的 provider MUST 只在日誌為空時做一次完整匯入，日誌非空時 MUST NOT 匯入。一致性 MUST 逐訊息種類（助手文字、工具呼叫、thinking、壓縮邊界、中斷標記、使用者訊息）判定；provider 歷史解析對同一份歷史檔重複讀取時，每則訊息 MUST 產生相同的 id，沒有 provider 原生 id 的訊息 MUST 以決定性規則產生 id（例如依歷史檔行號），MUST NOT 使用隨機 id。

#### Scenario: Codex 歷史 id 決定性
- **WHEN** 同一份 Codex rollout（含 reasoning、`compacted`、使用者訊息與 `<turn_aborted>`）被解析兩次
- **THEN** 兩次產生的所有訊息 id 逐則相同；reasoning 的 id 等於即時事件的 `item.id`

#### Scenario: 未具 id 契約的 provider
- **WHEN** 一個 Cursor 會話已有日誌，provider 歷史中有日誌沒有的訊息
- **THEN** 讀取結果只包含日誌中的訊息，不匯入

#### Scenario: 既有會話第一次讀取
- **WHEN** 一個在本變更前建立、日誌為空的會話第一次被讀取
- **THEN** provider 歷史全部依順序匯入日誌，讀取結果與匯入後的日誌相同

### Requirement: 以序號為游標的讀取介面
`GET /api/providers/sessions/:sessionId/messages` SHALL 回傳依 `seq` 升冪排序的訊息，支援 `limit` 與 `beforeSeq` 參數：提供 `beforeSeq` 時回傳 `seq < beforeSeq` 的最後 `limit` 則。回應 MUST 包含是否還有更早訊息的旗標。在新舊讀取路徑以旗標並存的過渡期間，系統 MUST 同時接受 `offset` 參數（同時帶 `beforeSeq` 時以 `beforeSeq` 為準），以支援舊前端與旗標回滾；移除旗標後 `offset` 參數 MUST 不再被接受。

#### Scenario: 過渡期的舊前端分頁
- **WHEN** 伺服器已開啟讀日誌旗標，前端仍為舊 store，以 `offset=20&limit=20` 請求更早訊息
- **THEN** 請求成功，回傳對應範圍的訊息

#### Scenario: 載入更早的訊息
- **WHEN** 前端目前最早一則訊息的 `seq` 為 40，請求 `beforeSeq=40&limit=20`
- **THEN** 回傳 `seq < 40` 的最後 20 則，依 `seq` 升冪，並標示是否還有更早訊息

### Requirement: 重新連線依序號補回遺漏訊息與串流中的段落
前端重新連線（含整頁重新整理後的首次連線）並查詢會話狀態時 SHALL 附上目前持有的最大 `seq`；系統 MUST 依序：回送該會話日誌中 `seq` 更大的所有訊息；若該會話仍在執行且目前段落尚未定稿，把該段落已送出的完整文字以一則 `stream_delta` 補送；最後接續即時流。段落文字 MUST 只保留在記憶體中，MUST NOT 寫入日誌，並在段落定稿或執行結束時清除。重新連線時，若該會話仍在執行，系統 MUST 沿用該次執行原本的 `LoggingWriter` 實例（只更換底層連線），MUST NOT 另建新實例，不論 runtime 在重新連線時是更換底層 socket 還是整個替換 writer。

#### Scenario: Codex 重新連線後的段落補送
- **WHEN** Codex 執行中助手段落串流到一半，前端重新連線，Codex runtime 在重新連線時整個替換 writer
- **THEN** 前端收到補送的完整前半段，之後的片段接續其後；日誌暫存與段落累加內容沒有遺失

#### Scenario: 斷線期間的工具結果
- **WHEN** WebSocket 斷線期間 runtime 送出的 `tool_result` 被 `WebSocketWriter.send` 丟棄，前端重新連線時附上 `seq` 12
- **THEN** 前端收到日誌中 `seq > 12` 的訊息（含該工具結果），之後才收到新的即時訊息

#### Scenario: 串流中途重新整理
- **WHEN** 助手正在串流一段回覆，已輸出「我先讀取設定檔，接著修改 par」時使用者重新整理頁面
- **THEN** 重新連線後前端先收到補送的「我先讀取設定檔，接著修改 par」，再接續收到之後的片段；畫面上該段落從開頭完整顯示，不出現缺頭的空窗

#### Scenario: 補送與定稿相鄰
- **WHEN** 重新連線時該段落恰好定稿（收到 `stream_end` 與同 id 的 `text`）
- **THEN** 段落以定稿訊息呈現一次，不因補送而重複

### Requirement: 單則內容上限
系統 SHALL 對寫入日誌的單則 `payload` 設定 512 KB 的大小上限；超出時 MUST 截斷並標記 `truncated: true`。讀取時若 provider 歷史有該則的完整內容，MUST 以完整內容回傳但不寫回超出上限的部分。

#### Scenario: 超大工具輸出
- **WHEN** 一則 `tool_result` 的內容超過 512 KB
- **THEN** 日誌中儲存截斷後的內容並標記 `truncated: true`；讀取時若歷史中有完整輸出，回傳完整輸出

### Requirement: 日誌隨會話刪除
刪除或硬刪會話時，系統 SHALL 一併刪除該會話的日誌資料列；硬刪除專案時，系統 MUST 在同一交易中刪除該專案所有會話的日誌資料列。封存與收藏 MUST NOT 影響日誌。

#### Scenario: 刪除會話
- **WHEN** 使用者永久刪除一個會話
- **THEN** `session_messages` 中該會話的資料列全部刪除

#### Scenario: 硬刪除專案
- **WHEN** 使用者硬刪除一個含三個會話的專案
- **THEN** `session_messages` 中這三個會話的資料列全部刪除，不留孤兒資料列

### Requirement: 日誌依時間與總大小清理
系統 SHALL 在伺服器啟動時與之後每 24 小時清理一次日誌：先刪除最後更新時間早於保留期限（預設 90 天）的會話日誌；若總大小（以 `payload` 長度總和計）仍超過上限（預設 1 GB），依最後更新時間由舊到新刪除會話日誌，直到低於上限的 90%。會話的「最後更新時間」MUST 以該會話日誌資料列 `updated_at` 的最大值為準。清理 MUST 以整個會話為單位，MUST NOT 只刪除會話中的部分訊息。收藏的會話與執行中的會話 MUST NOT 被清理。保留天數與大小上限 MUST 可由設定調整，設為 0 表示停用該項清理。

#### Scenario: 超過保留期限
- **WHEN** 一個未收藏、未執行中的會話最後更新於 120 天前
- **THEN** 清理後該會話的日誌資料列全部刪除；使用者再次打開時由 provider 歷史完整匯入並顯示對話內容

#### Scenario: 總大小超過上限
- **WHEN** 日誌總大小為 1.2 GB，且沒有會話超過保留期限
- **THEN** 依最後更新時間由舊到新刪除未收藏、未執行中的會話日誌，直到總大小低於 0.9 GB

#### Scenario: 收藏的會話
- **WHEN** 一個收藏的會話最後更新於 200 天前
- **THEN** 清理不刪除該會話的日誌
