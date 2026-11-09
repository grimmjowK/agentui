## 1. 前置：id 契約一致性與現況基準

> **閘門**：1.0、1.1、1.2、1.3 全部通過，design D8 契約表每一格皆為「穩定」，才進入第 2 節（design Migration Plan 第 0 步）。1.3 若無法修正，停下來重新評估方案，不帶缺口進入實作。

- [x] 1.0 確認部署為單一副本、SQLite 檔不被多個行程同時寫入（design D4），結論寫入部署文件
- [x] 1.1 新增一致性測試工具（design D8）：給定一份錄製的即時事件流與對應的 provider 歷史檔，重放即時流取得訊息 id 集合，解析歷史取得 id 集合，**依訊息種類**（助手文字、工具呼叫、工具結果、thinking、壓縮邊界、中斷標記、使用者訊息）輸出「只在即時」「只在歷史」「兩邊都有」三組清單；另檢查「同一份歷史讀兩次 id 是否相同」，判定各種類的歷史 id 是否穩定；並斷言「重放後每一則即時使用者訊息都配對到 provider 的訊息」（只驗證「沒有新增匯入」會漏掉 h ≠ l 時的配對失敗）
- [x] 1.3 **（先做）** 錄製一份 Claude 多步驟執行（含 `tool_result`、錯誤、中斷），跑一致性測試；若任一種類 id 不一致，在 Claude runtime 或歷史解析修正；修不好則停在此處重新評估
- [x] 1.2a Codex 歷史解析改用決定性 id（design D8）：`mapRolloutEntry` 的 `reasoning` 取 `payload.id`；`compacted`、使用者訊息、中斷標記等沒有 provider id 的條目改用 `codex_${sessionId}_${lineIndex}`，不再落到 `generateMessageId`；附測試（同一份 rollout 讀兩次，所有訊息 id 相同）
- [x] 1.2b Codex parser 合併同一回合文字相同的 `event_msg/user_message` 與 `response_item` 使用者訊息為一則（design D8，防禦性），id 取 `response_item` 行號 id、另一行 id 記入 `provider_ids`；附測試（手工構造兩種格式並存的 rollout，只產生一則使用者訊息）
- [x] 1.2 以 Codex（`docs/fixtures/codex` 加一份新錄製的多步驟 rollout，含插話、中斷與壓縮）、Antigravity（`docs/fixtures/antigravity`）跑一致性測試；結果回填 design D8 契約表
- [ ] 1.4 把瀏覽器取樣比對（每 300ms 偵測重複、執行中與結束後重新整理逐則比對）整理成 `docs/` 下的手動驗收腳本，並在目前程式碼上記錄 Claude／Codex／Antigravity 各一輪的基準結果

## 2. 階段一：日誌資料表與只寫不讀

- [x] 2.1 在 `migrations.ts` 新增 `session_messages` 資料表（`session_id`、`id`、`seq REAL`、`provider_ids`、`payload`、`source`、`created_at`、`updated_at`；主鍵 `(session_id, id)`，索引 `(session_id, seq)`）；在 `connection.ts` 建立連線時執行 `PRAGMA journal_mode = WAL`（design D14，目前未設定）
- [x] 2.2 新增 `session-messages.db.ts` repository：`append`（即時寫入，指派 `floor(max)+1`）、`insertUserIfAbsent`（使用者訊息專用，不覆寫）、`upsertById`（保留 `seq`、只覆蓋非空欄位）、`foldToolResult`（依 `toolId` 寫入同會話 `tool_use` 列的 `toolResult`）、`insertBetween`（中點）、`list(sessionId, { beforeSeq, limit })`、`maxSeq`、`deleteBySession`、`renumber`；附整合測試
- [x] 2.3 新增 `LoggingWriter`（design D2、D3、D5）：
  - 判斷持久性種類、寫入並補上 `seq` 後交給原 writer；單則 `payload` 512 KB 上限與 `truncated` 標記
  - **完整代理** `ws`、`userId`、`sessionId`、`updateWebSocket`、`setSessionId`、`getSessionId`；固定宣告 `isWebSocketWriter = true`，讓 Codex／Antigravity 的 `send` 一律送物件；收到字串時先 `JSON.parse`，失敗則原樣轉交並 `logger.warn`（design D2）
  - 每次執行一個實例，維護會話 id 確定前的暫存佇列；新會話在 `session_created`／`setSessionId` 前**不採信訊息自帶的 `sessionId`**（Antigravity 臨時 UUID）；確定時先寫入暫存、對前端**先送 `session_created` 再送暫存訊息**；執行結束仍未確定則暫存只送不寫
  - 帶 `toolId` 的 `tool_result` 併入同 `toolId` 的 `tool_use`（保留 `seq`、送出更新後的 `tool_use`），找不到才以 `${toolId}:result` 獨立寫入
  - 收到 `complete(aborted: true)` 且該次執行未送過 `isInterrupted` 訊息時，先寫入並送出 id 為 `${sessionId}:interrupted:${runId}` 的中斷標記，再送 `complete`
  - 會話 id 確定後登記到以會話 id 為鍵的登記表、執行結束時移除（design D10，供 2.4 的中斷與重新連線查找）
  - 附單元測試：兩個並行新會話不互混；Antigravity 在 `init` 前送出的錯誤不寫入日誌；`session_created` 先於暫存訊息送出；Codex（同 id `tool_use` 帶結果）、Antigravity（獨立 `:result`）、Claude（獨立 `_tr_`）三種形態寫入後日誌都只有一列帶 `toolResult` 的 `tool_use`；Claude／Antigravity 中斷後日誌有一則中斷標記、Codex 中斷後不重複產生
- [x] 2.4 在 `chat-websocket.service.ts` 包裝 `LoggingWriter`（design D2）：
  - `chat-command`（`runtime.start`）建立新實例
  - 重新連線（`runtime.reconnect`）先查登記表，查到就 `updateWebSocket` 後沿用同一實例，查不到才新建
  - `abort-session` 把登記的實例傳給 `runtime.abort`
  - 派發處所有送出改走 `sendToClient(writer, message)`（含審批失敗的 `task_notification`）
  - 外部 REST API（`routes/agent.js`）在 `runtime.start` 前同樣以 `LoggingWriter` 包裝 `SSEStreamWriter`／`ResponseCollector`，新會話與帶 `sessionId` 的接續都包裝（design D2）；附測試（以 `sessionId` 接續時日誌有寫入、執行中登記表查得到該會話，UI 同時讀取不會匯入）
- [x] 2.4a 不變量測試：以**真實的** Codex（假 app-server）、Antigravity（假 agy）、Claude（mock SDK）runtime 驅動，以假的 ws 收集一整輪（含中斷、審批失敗、插話、中途重新連線）送出的訊息，斷言每則持久性種類的訊息都帶 `seq`；並斷言 Claude、Codex、Antigravity 重新連線前後經手的是同一個 `LoggingWriter` 實例
- [x] 2.4b 移除 `antigravity-cli.js` `liveWriter` 的 `pending` 斷線暫存，`send` 一律直接交給 `LoggingWriter`（design D10）；附測試（斷線期間送出的 `tool_result` 已寫入日誌）
- [x] 2.5 `chat-command` 與 `chat-steer` 使用 `clientId` 欄位（沿用插話既有命名），伺服器驗證為 UUID，不符即拒絕；日誌 id 為 `user:<clientId>`，以 insert-if-absent 寫入（同一使用者、同一會話的同 id 使用者訊息視為冪等重送，其他情況拒絕、不覆寫）（design D6）；圖片只存中繼資料；插話只在被接受時寫入；附測試（`clientId` 非 UUID 被拒；`clientId` 對應的 id 已是工具訊息時被拒且原列不變；同一則使用者訊息重送不新增列）；`chat-command` 的順序調整為「記錄使用者訊息 → `warnOnConcurrentShellSession` → `runtime.start`」（design D6）；前端送出 `chat-command` 時產生並附上 `clientId`，暫不改變前端顯示
- [x] 2.6 刪除會話時呼叫 `deleteBySession`；`sessionsDb.deleteSessionsByProjectPath` 在同一交易中先刪除該專案所有會話的 `session_messages` 再刪 `sessions`（design D14）；封存與收藏不影響；附測試（硬刪除專案後無孤兒日誌）
- [x] 2.6a 日誌清理（design D13）：伺服器啟動時與每 24 小時執行；「最後更新時間」以 `session_messages` 依 `session_id` 彙總的 `MAX(updated_at)` 為準；先依保留天數、再依總大小以會話為單位由舊到新刪除，`LEFT JOIN sessions` 跳過收藏、查登記表跳過執行中的會話；維護按會話彙總的 `payload` 大小；`SESSION_LOG_RETENTION_DAYS`（預設 90）與 `SESSION_LOG_MAX_BYTES`（預設 1 GB）可設定、0 為停用，寫入 `.env.example`；附測試（逾期刪除、超量刪到 90%、收藏與執行中不刪、清理後讀取會重新匯入）
- [x] 2.7 Claude runtime 的錯誤包裝去重搬到伺服器端（design D9）：SDK 拋出的錯誤若已以助手正文送出過，不再送出 `error`，附測試
- [x] 2.8 新增僅開發環境可用的診斷端點，列出某會話日誌與舊 `fetchHistory` 結果的差異；在開發機以 Claude／Codex／Antigravity 各跑數輪並檢視差異

## 3. 階段二：伺服器讀日誌與對帳

- [x] 3.1 新增對帳服務（design D7）：依 provider 歷史順序處理已對應（補齊內容欄位並寫回、`seq` 不變）、尾端未對應（追加，`source=import`）、中段未對應（中點插入）；忽略歷史中的獨立 `tool_result`（內容已由 provider 掛到 `tool_use.toolResult`）
- [x] 3.1a 抽出即時與歷史共用的「不參與使用者訊息配對」判定函式（design D8 排除項：中斷標記、壓縮邊界、Codex 內部注入文字、Claude `isMeta`、本地指令輸出、壓縮摘要），以現有 `isInternalCodexUserText` 與 Claude `isMeta` 判斷為基礎；兩側改用同一函式
- [x] 3.1b 使用者訊息以錨點切段、段內配對（design D8）：l = 0 全部匯入；h = l 依序對應，歷史側 id 穩定時才記入 `provider_ids`；h ≠ l 不配對不匯入並 `logger.warn`；中斷標記與壓縮邊界以同段兩側皆有視為已對應
- [x] 3.1c 執行中的會話（查登記表）只補齊不匯入（design D7）
- [x] 3.1d 分岔偵測與重建（design D7）：只依 D8 判定為穩定的 id 判斷「已對應訊息從非空的 provider 歷史中消失」；成立時單一交易刪除該會話日誌並完整重新匯入，`logger.warn` 記錄原因；另加管理端點手動觸發重建
- [x] 3.2 對帳啟用閘門（design D8）：provider 須在設定中標記已通過一致性測試；未通過者只在日誌為空時完整匯入
- [x] 3.3 provider 歷史讀取加上依檔案 mtime 的快取，避免每次讀取都重新解析
- [x] 3.4 `seq` 間隙耗盡時整體重新編號（單一交易），附測試
- [x] 3.5 `GET /sessions/:id/messages` 在旗標開啟時改走「對帳 → 讀日誌」，新增 `beforeSeq` 與 `limit`，回傳是否還有更早訊息；**過渡期同時接受 `offset`**（帶 `beforeSeq` 時以它為準），供舊 store 與旗標回滾使用（design D12）
- [x] 3.6 讀取時對截斷的 `payload` 以 provider 歷史的完整內容回傳但不寫回
- [x] 3.7 新增設定旗標，並在 `/api/config` 回報狀態供前端判斷（design Migration Plan）
- [x] 3.8 對帳服務測試：補齊完整 diff、終端機新回合尾端匯入、Codex 注入訊息中段插入、只傳圖片的使用者訊息依順序對應、未具契約 provider 不匯入、既有會話首次完整匯入、重複讀取結果相同；段內數量不符時不配對也不匯入、Codex `<turn_aborted>` 不造成後續錯位、插話訊息正確配對、執行中讀取不產生匯入且結束後讀取結果與一次跑完相同、模擬 Claude `/rewind`（歷史截短）觸發重建；**以及**：Codex 會話連續讀取十次不觸發重建、不新增任何資料列（隨機 id 回歸）；Codex 歷史的 thinking 與壓縮邊界不重複匯入；Antigravity 工具結果不因形態差異產生額外資料列

## 4. 階段三：前端切換

- [x] 4.1 把 store 的狀態轉移抽成純函式 `applyLogMessage(slot, msg)`（按 id upsert、依 `seq` 排序；不帶 `seq` 的串流暫存置於尾端）與 `replaceWithFetched(slot, messages)`（整份取代、保留串流暫存），附單元測試
- [x] 4.2 `useSessionStore` 在旗標開啟時改用上述純函式；移除 `computeMerged`、`interleaveByTimestamp`、`dedupeAdjacentAssistantEchoes`、`isErrorAlreadyShown`、`isTransientRetryRecovered`、使用者文字指紋比對、`overlayDefinedFields` 與 `refreshFromServer` 的保留白名單
- [x] 4.2a 移除 `useChatRealtimeHandlers.ts` 收到 `complete(aborted)` 時本地合成中斷標記的邏輯，改由伺服器送出（design D3）
- [x] 4.3 樂觀使用者訊息以 `user:<clientId>` 顯示，收到同 id 帶 `seq` 的訊息後取代，取代時保留本地的 `images`（design D6；只限使用者訊息的 `images`）；插話改為送出時即以 `clientId` 顯示樂觀訊息，不再等 `steer-accepted` 才 `addMessage`，被拒時移除
- [x] 4.4 `finalizeStreaming`：`stream_end` 帶 `messageId` 時沿用該 id 等待定稿 `text` 取代；不帶 `messageId` 時保留暫存，收到下一則帶 `seq` 的助手 `text` 或 `complete` 時清除，不以隨機 id 轉成正式訊息（design D3、D9）；附測試
- [x] 4.5 分頁改用 `beforeSeq`（`fetchMore`、`useChatSessionState` 的載入更多）
- [x] 4.6 重新連線補回（design D10）：`check-session-status` 附上目前最大 `seq`，伺服器回送 `seq` 更大的日誌訊息後再接續即時流；附整合測試（斷線期間送出的 `tool_result` 在重新連線後出現）
- [x] 4.7 串流段落補送（design D10）：`LoggingWriter` 累加目前段落文字、於定稿或執行結束時清除（經 2.3 的登記表供重新連線查得）；重新連線時在日誌補回之後、即時流之前補送一則 `stream_delta`；附測試（段落中途重新連線看到完整前半段；補送與定稿相鄰不重複；Codex 重新連線換 writer 後仍取得同一份累加內容）

## 5. 所見即所得驗收

- [x] 5.1 新增自動驗收（design D11）：以錄製事件流與假的 CLI 執行檔驅動 Claude（mock SDK）、Codex（假 app-server）、Antigravity（假 agy）真實 runtime 與 `LoggingWriter`，同時把送出的訊息套用到 `applyLogMessage`；結束後讀取，斷言逐則相同，不同時輸出第一個差異位置與兩側內容
- [x] 5.2 驗收情境涵蓋錯誤（含重試耗盡）、警告、中斷（Claude、Codex、Antigravity 各一）、審批失敗、插話、工具 started→completed 更新、壓縮邊界、只傳圖片的使用者訊息、新會話第一則訊息、「執行中任意時點插入一次讀取」，以及「串流段落中途重新連線」（Claude、Codex、Antigravity 各一）
- [x] 5.3 把驗收納入 `npm test`
- [ ] 5.4 以 1.4 的手動驗收腳本在瀏覽器實測 Claude／Codex／Antigravity 各一輪，與 1.4 的基準比較並記錄結果

## 6. 收尾

- [ ] 6.1 預設開啟旗標（已完成，支援 `SESSION_MESSAGE_LOG_ENABLED=0` 回滾），觀察一段時間後移除旗標與舊合併程式碼；同時移除讀取 API 的 `offset` 參數（**BREAKING**，design D12）
- [x] 6.2 更新 `server/modules/MODULES.md`、`src/SRC.md` 與 `server/modules/providers/README.md`，說明日誌為訊息唯一來源、provider 歷史只用於匯入與補齊
- [x] 6.3 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 全部通過
