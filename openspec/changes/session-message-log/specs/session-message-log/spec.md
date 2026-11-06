## ADDED Requirements

### Requirement: 持久性訊息在送出前寫入對話日誌
系統 SHALL 在把下列種類的 `NormalizedMessage` 送往前端之前，先寫入伺服器端的對話日誌（`session_messages`）：`text`（使用者與助手）、`thinking`、`tool_use`、`tool_result`、`error`、`status` 為 `warning` 或 `error` 的 `task_notification`、帶 `isInterrupted` 的訊息、壓縮邊界。`stream_delta`、`stream_end`、`status`、`session_created`、`complete`、`permission_request`、`permission_cancelled` 與 `status` 為 `info` 的 `task_notification` MUST NOT 寫入日誌。寫入 MUST 發生在聊天派發處包裝的 writer（`LoggingWriter`）中，涵蓋 `runtime.start` 與 `runtime.reconnect` 傳入的 writer。外部 REST API（`/api/agent`）的執行 MUST NOT 寫入日誌；這類會話在 UI 第一次讀取時依匯入規則從 provider 歷史取得。

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

### Requirement: 伺服器指派會話內唯一且穩定的序號
系統 SHALL 為每則新寫入的訊息指派該會話內唯一的序號 `seq`，新訊息的 `seq` MUST 大於該會話所有既有訊息的 `seq`。同一會話內以相同 `id` 再次寫入時，系統 MUST 就地更新內容並保留原 `seq`，且只以新值中非 `undefined`／`null` 的欄位覆蓋。送往前端的持久性訊息（新增與更新）MUST 帶上 `seq`。

#### Scenario: 工具從開始到完成
- **WHEN** Codex 對同一工具先送出 `item/started` 映射的 `tool_use`（id `call_1`），再送出 `item/completed` 映射的同 id `tool_use`（含 `toolResult`）
- **THEN** 日誌中只有一列 `call_1`，`seq` 為第一次寫入時指派的值，內容包含 `toolResult`；兩次送往前端的訊息帶相同 `seq`

#### Scenario: 序號遞增
- **WHEN** 同一會話依序寫入訊息 A、B、C
- **THEN** `seq(A) < seq(B) < seq(C)`

### Requirement: 會話 id 確定前的訊息依序暫存
系統 SHALL 為每次執行保留暫存佇列，存放 `sessionId` 尚未確定時送出的持久性訊息；在該次執行收到 `session_created` 或 writer 被設定會話 id 時，MUST 依原順序寫入日誌、指派序號後再送出。兩個在同一連線上並行的新會話 MUST NOT 互相混入對方的暫存訊息。

#### Scenario: 新會話的第一則使用者訊息
- **WHEN** 使用者在新會話送出第一則訊息，派發處記錄使用者訊息時尚無會話 id，隨後 runtime 送出 `session_created`
- **THEN** 使用者訊息以 `seq` 最小的位置寫入該新會話的日誌，並早於任何助手訊息

### Requirement: 使用者訊息由伺服器以客戶端 id 記錄
系統 SHALL 在收到 `chat-command` 時，以請求中的 `clientMessageId` 為 id 寫入一則使用者 `text` 訊息並送回前端（帶 `seq`）。圖片 MUST 只記錄檔名與尺寸等中繼資料，MUST NOT 把 base64 本體寫入日誌。

#### Scenario: 只傳圖片的訊息
- **WHEN** 使用者送出不含文字、附一張圖片的訊息，`clientMessageId` 為 `local_abc`
- **THEN** 日誌中出現 id 為 `local_abc` 的使用者訊息，包含圖片中繼資料但不含 base64 內容；前端收到帶 `seq` 的同 id 訊息

### Requirement: 讀取時在伺服器端匯入與補齊 provider 歷史
讀取會話訊息時，系統 SHALL 依 provider 歷史的順序與日誌對帳：歷史訊息的 id（或已記錄的 provider id）已在日誌中時，MUST 以歷史中的內容欄位補齊日誌並寫回，且 MUST NOT 改變其 `seq`；歷史訊息不在日誌中且位於所有已對應訊息之後時，MUST 追加到日誌尾端；位於兩則已對應訊息之間時，MUST 以前後兩者 `seq` 之間的值插入。歷史中的使用者訊息 MUST 以回合內順序（歷史中第 k 則未對應者 ↔ 日誌中同位置之後第 k 則未對應的使用者訊息）對應，而非文字比對。對帳結果寫回日誌後，相同輸入的再次讀取 MUST 產生相同結果。

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

### Requirement: 對帳以 provider 的 id 契約一致性為啟用前提
系統 SHALL 只對通過「即時重放寫入日誌後，以 provider 歷史對帳不產生任何新匯入」一致性測試的 provider 啟用中段與尾端匯入。未通過的 provider MUST 只在日誌為空時做一次完整匯入，日誌非空時 MUST NOT 匯入。

#### Scenario: 未具 id 契約的 provider
- **WHEN** 一個 Cursor 會話已有日誌，provider 歷史中有日誌沒有的訊息
- **THEN** 讀取結果只包含日誌中的訊息，不匯入

#### Scenario: 既有會話第一次讀取
- **WHEN** 一個在本變更前建立、日誌為空的會話第一次被讀取
- **THEN** provider 歷史全部依順序匯入日誌，讀取結果與匯入後的日誌相同

### Requirement: 以序號為游標的讀取介面
`GET /api/providers/sessions/:sessionId/messages` SHALL 回傳依 `seq` 升冪排序的訊息，支援 `limit` 與 `beforeSeq` 參數：提供 `beforeSeq` 時回傳 `seq < beforeSeq` 的最後 `limit` 則。回應 MUST 包含是否還有更早訊息的旗標。`offset` 參數 MUST 不再被接受。

#### Scenario: 載入更早的訊息
- **WHEN** 前端目前最早一則訊息的 `seq` 為 40，請求 `beforeSeq=40&limit=20`
- **THEN** 回傳 `seq < 40` 的最後 20 則，依 `seq` 升冪，並標示是否還有更早訊息

### Requirement: 重新連線依序號補回遺漏訊息與串流中的段落
前端重新連線（含整頁重新整理後的首次連線）並查詢會話狀態時 SHALL 附上目前持有的最大 `seq`；系統 MUST 依序：回送該會話日誌中 `seq` 更大的所有訊息；若該會話仍在執行且目前段落尚未定稿，把該段落已送出的完整文字以一則 `stream_delta` 補送；最後接續即時流。段落文字 MUST 只保留在記憶體中，MUST NOT 寫入日誌，並在段落定稿或執行結束時清除。

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
刪除或硬刪會話時，系統 SHALL 一併刪除該會話的日誌資料列；封存與收藏 MUST NOT 影響日誌。

#### Scenario: 刪除會話
- **WHEN** 使用者永久刪除一個會話
- **THEN** `session_messages` 中該會話的資料列全部刪除

### Requirement: 日誌依時間與總大小清理
系統 SHALL 在伺服器啟動時與之後每 24 小時清理一次日誌：先刪除最後更新時間早於保留期限（預設 90 天）的會話日誌；若總大小（以 `payload` 長度總和計）仍超過上限（預設 1 GB），依最後更新時間由舊到新刪除會話日誌，直到低於上限的 90%。清理 MUST 以整個會話為單位，MUST NOT 只刪除會話中的部分訊息。收藏的會話與執行中的會話 MUST NOT 被清理。保留天數與大小上限 MUST 可由設定調整，設為 0 表示停用該項清理。

#### Scenario: 超過保留期限
- **WHEN** 一個未收藏、未執行中的會話最後更新於 120 天前
- **THEN** 清理後該會話的日誌資料列全部刪除；使用者再次打開時由 provider 歷史完整匯入並顯示對話內容

#### Scenario: 總大小超過上限
- **WHEN** 日誌總大小為 1.2 GB，且沒有會話超過保留期限
- **THEN** 依最後更新時間由舊到新刪除未收藏、未執行中的會話日誌，直到總大小低於 0.9 GB

#### Scenario: 收藏的會話
- **WHEN** 一個收藏的會話最後更新於 200 天前
- **THEN** 清理不刪除該會話的日誌
