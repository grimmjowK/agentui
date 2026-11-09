## 1. 佇列狀態

- [ ] 1.1 新增 `src/stores/useQueuedMessagesStore.ts`（Zustand）：以 sessionKey 保存 `QueuedMessage[]`，提供 `enqueue`、`remove`、`shift`（跳過 `steerState === 'pending'`）、`setSteerState`、`renameSession`
- [ ] 1.2 為 store 寫單元測試：依會話隔離、`shift` 跳過引導中的項目、`renameSession` 搬移並合併到新 key

## 2. 送出流程

- [ ] 2.1 從 `useChatComposerState.handleSubmit` 抽出 `startTurn({ text, images })`（上傳圖片、加入使用者訊息、送出指令）；`handleSubmit` 的非生成中分支改為呼叫它，行為不變
- [ ] 2.2 生成中的 `handleSubmit` 改為 `enqueue` 目前輸入與附件並清空輸入框；移除「生成中直接送 `chat-steer`」的舊路徑
- [ ] 2.3 新增「送出佇列項目」：以項目的 text 與 images 走非生成中的送出分支（含斜線指令攔截），送出後從佇列移除
- [ ] 2.4 在 `session_created` 與 `complete` 的 `actualSessionId` 替換處呼叫 `renameSession`，把 `'__new__'` 或舊 id 的佇列搬到新 id

## 3. 這一輪結束的處理

- [ ] 3.1 `useChatRealtimeHandlers` 新增 `onTurnEnded(sessionId, outcome)`，依 design D3 由 `complete` / `error` 判斷 `completed` / `aborted` / `error`；為判斷規則寫單元測試
- [ ] 3.2 輸入框狀態接上 `onTurnEnded`：只有 `completed` 且是畫面上的會話時，延到狀態更新後自動送出佇列第一則

## 4. 立即引導

- [ ] 4.1 立即引導改由佇列項目觸發：設 `steerState: 'pending'`、送 `chat-steer`（`clientId` 為項目 id）；同時只允許一則等待回覆
- [ ] 4.2 改寫 `handleSteerResult`：接受時移除項目並加入使用者訊息；拒絕時項目回到 idle、顯示原因，`not_running` 沿用 `check-session-status` 校正；這一輪結束時把殘留的 pending 項目重設為 idle

## 5. UI 與 i18n

- [ ] 5.1 新增 `ChatComposer` 子元件 `QueuedMessages`：依 design D5 顯示文字預覽、圖片數、立即引導／送出／移除按鈕
- [ ] 5.2 `ChatComposer` 送出按鈕：生成中只要有內容即可按、提示改為排隊說明；移除 `canSteer` 對送出按鈕的特殊處理
- [ ] 5.3 八種語系的 `chat.json` `steer` 區塊新增 `queued`、`steerNow`、`sendNow`、`remove`、`queuedHint`，改寫 `hint`

## 6. 驗收（瀏覽器實測，`npm run dev`）

- [ ] 6.1 Claude 生成中送出兩則：兩則都出現在佇列、對話區不出現；這一輪結束後自動送出第一則，那一輪結束後再送第二則
- [ ] 6.2 Codex 執行工具中對佇列項目按立即引導：項目移到對話中、模型未中斷、回覆遵循插話
- [ ] 6.3 Claude 同上（驗證 `feat/claude-mid-turn-steer` 的插話路徑）
- [ ] 6.4 Cursor 生成中送出：進入佇列、沒有立即引導按鈕；這一輪結束後自動送出
- [ ] 6.5 佇列有項目時按停止：佇列保留、未自動送出，項目顯示送出按鈕，按下後開始新一輪
- [ ] 6.6 移除佇列項目後該則不會被送出；帶圖片的項目沒有立即引導按鈕，自動送出時圖片正常上傳
- [ ] 6.7 會話 A 排隊後切到 B：B 看不到 A 的佇列；A 在背景結束後切回，佇列仍在且未送出
- [ ] 6.8 新會話第一輪生成中就排隊：拿到 session id 後佇列仍在，這一輪結束後自動送出
- [ ] 6.9 `npm run typecheck`、`npm run lint`（0 錯誤）、`npm test`、`npm run build` 全部通過
