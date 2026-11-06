## 1. 前置：id 契約一致性與現況基準

- [ ] 1.1 新增一致性測試工具（design D8）：給定一份錄製的即時事件流與對應的 provider 歷史檔，重放即時流取得訊息 id 集合，解析歷史取得 id 集合，輸出「只在即時」「只在歷史」「兩邊都有」三組清單
- [ ] 1.2 以 Codex（`docs/fixtures/codex` 加一份新錄製的多步驟 rollout）、Antigravity（`docs/fixtures/antigravity`）跑一致性測試，確認助手文字與工具 id 完全對應；結果記入 design D8 表格
- [ ] 1.3 錄製一份 Claude 多步驟執行（含 `tool_result` 與錯誤），跑一致性測試；若 `tool_result` 或其他種類 id 不一致，先在 Claude runtime 或歷史解析修正，否則在 design 註記 Claude 暫不啟用對帳
- [ ] 1.4 把瀏覽器取樣比對（每 300ms 偵測重複、執行中與結束後重新整理逐則比對）整理成 `docs/` 下的手動驗收腳本，並在目前程式碼上記錄 Claude／Codex／Antigravity 各一輪的基準結果

## 2. 階段一：日誌資料表與只寫不讀

- [ ] 2.1 在 `migrations.ts` 新增 `session_messages` 資料表（`session_id`、`id`、`seq REAL`、`provider_ids`、`payload`、`source`、`created_at`、`updated_at`；主鍵 `(session_id, id)`，索引 `(session_id, seq)`），確認資料庫為 WAL 模式
- [ ] 2.2 新增 `session-messages.db.ts` repository：`append`（指派 `floor(max)+1`）、`upsertById`（保留 `seq`、只覆蓋非空欄位）、`insertBetween`（中點）、`list(sessionId, { beforeSeq, limit })`、`maxSeq`、`deleteBySession`、`renumber`；附整合測試
- [ ] 2.3 新增 `LoggingWriter`（design D2、D3、D5）：判斷持久性種類、寫入並補上 `seq` 後交給原 writer；每次執行一個實例並維護會話 id 確定前的暫存佇列；單則 `payload` 512 KB 上限與 `truncated` 標記；附單元測試（含兩個並行新會話不互混）
- [ ] 2.4 在 `chat-websocket.service.ts` 的 `chat-command`（`runtime.start`）與重新連線（`runtime.reconnect`）處包裝 `LoggingWriter`；外部 REST API（`routes/agent.js`）不包裝，並以測試確認 `/api/agent` 建立的會話在第一次讀取時由 provider 歷史完整匯入
- [ ] 2.5 `chat-command` 接受 `clientMessageId`，派發處以該 id 寫入使用者訊息（圖片只存中繼資料）；前端送出時產生並附上此 id，暫不改變前端顯示
- [ ] 2.6 會話刪除與硬刪除專案時呼叫 `deleteBySession`；封存與收藏不影響
- [ ] 2.6a 日誌清理（design D13）：伺服器啟動時與每 24 小時執行；先依保留天數、再依總大小以會話為單位由舊到新刪除，跳過收藏與執行中的會話；維護按會話彙總的 `payload` 大小；`SESSION_LOG_RETENTION_DAYS`（預設 90）與 `SESSION_LOG_MAX_BYTES`（預設 1 GB）可設定、0 為停用，寫入 `.env.example`；附測試（逾期刪除、超量刪到 90%、收藏與執行中不刪、清理後讀取會重新匯入）
- [ ] 2.7 Claude runtime 的錯誤包裝去重搬到伺服器端（design D9）：SDK 拋出的錯誤若已以助手正文送出過，不再送出 `error`，附測試
- [ ] 2.8 新增僅開發環境可用的診斷端點，列出某會話日誌與舊 `fetchHistory` 結果的差異；在開發機以 Claude／Codex／Antigravity 各跑數輪並檢視差異

## 3. 階段二：伺服器讀日誌與對帳

- [ ] 3.1 新增對帳服務（design D7）：依 provider 歷史順序處理已對應（補齊內容欄位並寫回、`seq` 不變）、尾端未對應（追加，`source=import`）、中段未對應（中點插入）；使用者訊息以回合內順序對應並記入 `provider_ids`
- [ ] 3.2 對帳啟用閘門（design D8）：provider 須在設定中標記已通過一致性測試；未通過者只在日誌為空時完整匯入
- [ ] 3.3 provider 歷史讀取加上依檔案 mtime 的快取，避免每次讀取都重新解析
- [ ] 3.4 `seq` 間隙耗盡時整體重新編號（單一交易），附測試
- [ ] 3.5 `GET /sessions/:id/messages` 在旗標開啟時改走「對帳 → 讀日誌」，支援 `beforeSeq` 與 `limit`，回傳是否還有更早訊息；移除 `offset`（**BREAKING**，同步更新前端呼叫）
- [ ] 3.6 讀取時對截斷的 `payload` 以 provider 歷史的完整內容回傳但不寫回
- [ ] 3.7 新增設定旗標，並在 `/api/config` 回報狀態供前端判斷（design Migration Plan）
- [ ] 3.8 對帳服務測試：補齊完整 diff、終端機新回合尾端匯入、Codex 注入訊息中段插入、只傳圖片的使用者訊息依順序對應、未具契約 provider 不匯入、既有會話首次完整匯入、重複讀取結果相同

## 4. 階段三：前端切換

- [ ] 4.1 把 store 的狀態轉移抽成純函式 `applyLogMessage(slot, msg)`（按 id upsert、依 `seq` 排序；不帶 `seq` 的串流暫存置於尾端）與 `replaceWithFetched(slot, messages)`（整份取代、保留串流暫存），附單元測試
- [ ] 4.2 `useSessionStore` 在旗標開啟時改用上述純函式；移除 `computeMerged`、`interleaveByTimestamp`、`dedupeAdjacentAssistantEchoes`、`isErrorAlreadyShown`、`isTransientRetryRecovered`、使用者文字指紋比對、`overlayDefinedFields` 與 `refreshFromServer` 的保留白名單
- [ ] 4.3 樂觀使用者訊息以 `clientMessageId` 顯示，收到同 id 帶 `seq` 的訊息後取代（含只傳圖片的情況）
- [ ] 4.4 `finalizeStreaming` 沿用 `stream_end` 的 `messageId`；定稿的 `text` 帶 `seq` 後依序號就位
- [ ] 4.5 分頁改用 `beforeSeq`（`fetchMore`、`useChatSessionState` 的載入更多）
- [ ] 4.6 重新連線補回（design D10）：`check-session-status` 附上目前最大 `seq`，伺服器回送 `seq` 更大的日誌訊息後再接續即時流；附整合測試（斷線期間送出的 `tool_result` 在重新連線後出現）
- [ ] 4.7 串流段落補送（design D10）：`LoggingWriter` 累加目前段落文字、於定稿或執行結束時清除，並以會話 id 登記供重新連線查得；重新連線時在日誌補回之後、即時流之前補送一則 `stream_delta`；附測試（段落中途重新連線看到完整前半段；補送與定稿相鄰不重複）

## 5. 所見即所得驗收

- [ ] 5.1 新增自動驗收（design D11）：以錄製事件流與假的 CLI 執行檔驅動 Claude（mock SDK）、Codex（假 app-server）、Antigravity（假 agy）真實 runtime 與 `LoggingWriter`，同時把送出的訊息套用到 `applyLogMessage`；結束後讀取，斷言逐則相同，不同時輸出第一個差異位置與兩側內容
- [ ] 5.2 驗收情境涵蓋錯誤（含重試耗盡）、警告、中斷、工具 started→completed 更新、只傳圖片的使用者訊息、「執行中任意時點插入一次讀取」，以及「串流段落中途重新連線」
- [ ] 5.3 把驗收納入 `npm test`
- [ ] 5.4 以 1.4 的手動驗收腳本在瀏覽器實測 Claude／Codex／Antigravity 各一輪，與 1.4 的基準比較並記錄結果

## 6. 收尾

- [ ] 6.1 驗收穩定後預設開啟旗標，觀察一段時間後移除旗標與舊合併程式碼
- [ ] 6.2 更新 `server/modules/MODULES.md`、`src/SRC.md` 與 `server/modules/providers/README.md`，說明日誌為訊息唯一來源、provider 歷史只用於匯入與補齊
- [ ] 6.3 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 全部通過
