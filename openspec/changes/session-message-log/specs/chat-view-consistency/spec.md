## ADDED Requirements

### Requirement: 任意時點的畫面等於重新整理後的畫面
對任一會話，系統 SHALL 保證在任意時點，前端的訊息序列（id、順序、內容）與「此刻重新整理頁面、重新讀取並重新連線後」的序列逐則相同，包含尾端串流中、尚未定稿的段落。串流暫存訊息 MUST 永遠位於所有已定稿訊息之後。

#### Scenario: 執行中重新整理
- **WHEN** 一次多步驟執行進行到第三個工具時使用者重新整理頁面
- **THEN** 重新整理後已定稿訊息的序列與重新整理前相同；執行繼續時新訊息接在尾端

#### Scenario: 串流中途重新整理
- **WHEN** 助手一段長回覆串流到一半時使用者重新整理頁面
- **THEN** 重新整理後該段落立即從開頭顯示已輸出的內容，並持續接續後續片段

#### Scenario: 錯誤在重新整理後位置不變
- **WHEN** 一輪執行在助手文字與兩個工具之後失敗並顯示錯誤，使用者重新整理頁面
- **THEN** 錯誤仍顯示，且位於第二個工具之後、與重新整理前相同的位置

### Requirement: 顯示順序只由序號決定
前端 SHALL 只依伺服器指派的 `seq` 排序持久性訊息，MUST NOT 依任何時間戳排序或插入。不帶 `seq` 的訊息（串流暫存與控制事件）MUST NOT 參與持久性訊息的排序，串流暫存一律置於尾端。

#### Scenario: 時鐘偏差不影響順序
- **WHEN** 伺服器時鐘比瀏覽器快 5 分鐘，且 provider 歷史的時間戳是步驟開始時間
- **THEN** 訊息順序與伺服器收到事件的先後一致，與任何時間戳無關

### Requirement: 前端按 id 更新、不做拼接
前端 SHALL 對帶 `seq` 的即時訊息按 id 新增或更新；讀取 API 的結果 SHALL 整份取代該會話的持久性訊息（保留尾端串流暫存）。前端 MUST NOT 以文字指紋、相鄰同文、錯誤包裝比對或任何其他啟發式合併、隱藏或重排訊息。

#### Scenario: 同 id 更新
- **WHEN** 前端已有 id `call_1`、`seq` 5 的工具卡片，又收到同 id、同 `seq`、帶 `toolResult` 的訊息
- **THEN** 畫面上仍只有一張 `call_1` 卡片，位置不變，顯示工具結果

#### Scenario: 執行中途拉取歷史
- **WHEN** 執行進行中前端重新讀取會話訊息
- **THEN** 取代後的序列與取代前已定稿的序列相同，不出現重複或消失

### Requirement: 串流暫存不以隨機 id 定稿
收到帶 `messageId` 的 `stream_end` 時，前端 SHALL 讓串流暫存等待同 id、帶 `seq` 的定稿 `text` 取代。收到不帶 `messageId` 的 `stream_end` 時，前端 MUST NOT 把暫存轉成隨機 id 的正式訊息，而是保留暫存，直到收到下一則帶 `seq` 的助手 `text` 或 `complete` 時清除。

#### Scenario: 不帶 messageId 的串流收尾
- **WHEN** 某 provider 送出不帶 `messageId` 的 `stream_end`，隨後送出 id 為 `uuid_0`、帶 `seq` 的助手 `text`
- **THEN** 畫面上只有一則助手回覆（`uuid_0`），不出現另一則隨機 id 的重複回覆

### Requirement: 前端不合成中斷標記
前端 SHALL 只顯示伺服器送出的中斷標記；收到 `complete(aborted: true)` 時 MUST NOT 自行在本地新增中斷標記。

#### Scenario: 中斷後重新整理
- **WHEN** 使用者中斷 Antigravity 執行，之後重新整理頁面
- **THEN** 重新整理前後都只有一則中斷標記，id 與位置相同

### Requirement: 樂觀使用者訊息以同 id 取代
前端送出訊息時 SHALL 產生 `clientId`，先以該 id 顯示樂觀訊息；收到伺服器帶 `seq` 的同 id 訊息後 MUST 以之取代，位置依 `seq`；取代時 MUST 保留樂觀訊息本地的 `images`（只存在於前端記憶體，伺服器版本不含圖片本體）。這是「按 id 更新」唯一的欄位保留例外。重新整理後使用者訊息不顯示縮圖，與現況相同。

#### Scenario: 只傳圖片
- **WHEN** 使用者送出只含圖片的訊息
- **THEN** 畫面上只有一則使用者訊息（帶縮圖），收到伺服器回送後仍只有一則且仍帶縮圖；重新整理後也只有一則（不帶縮圖）

### Requirement: 錯誤一律顯示，不由前端推斷是否已恢復
前端 SHALL 顯示日誌中所有 `error` 訊息與 `status` 為 `warning`／`error` 的 `task_notification`。是否為暫時性錯誤、是否已恢復，MUST 由伺服器端 runtime 在送出前決定；前端 MUST NOT 依訊息內容或前後訊息推斷並隱藏。

#### Scenario: 重試耗盡後失敗
- **WHEN** 一輪執行先輸出助手文字與工具，之後 provider 重試耗盡並送出 `API error (attempt 5): ...`
- **THEN** 錯誤顯示在工具之後，重新整理後仍在同一位置

### Requirement: 所見即所得的自動驗收
系統 SHALL 提供自動驗收：以錄製的 provider 事件流與假的 CLI 執行檔驅動真實 runtime 與日誌寫入，同時把送出的訊息套用到前端 store 的純函式；執行結束後讀取會話訊息，MUST 斷言兩份序列逐則相同。驗收 MUST 涵蓋 Claude、Codex、Antigravity，至少包含錯誤、警告、中斷（Claude、Codex、Antigravity 各一）、審批失敗、插話、工具更新、壓縮邊界、新會話第一則訊息各一例，並包含「執行中任意時點插入一次讀取」與「串流段落中途重新連線」的情境。此驗收 MUST 納入 `npm test`。

#### Scenario: 驗收發現不一致
- **WHEN** 某次修改使即時序列與重新讀取的序列在第 7 則不同
- **THEN** `npm test` 失敗，並指出第一個不同的位置與兩側內容
