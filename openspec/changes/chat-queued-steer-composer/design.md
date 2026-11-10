## Context

插話（steer）的前後端鏈路已經存在且通用：

- 前端 `useChatComposerState.ts`：`canSteer = isLoading && PROVIDER_INFO[provider].capabilities.midTurnSteer && sessionId`。生成中按送出就直接送 `chat-steer`，並先樂觀地加入使用者訊息；收到 `steer-rejected` 時移除訊息、保留輸入。`pendingSteerRef` 限制同時只能有一則在等待回覆。
- 後端 `chat-websocket.service.ts` 依 provider 呼叫 `runtime.steer()`，回覆 `steer-accepted` / `steer-rejected { reason }`。
- 目前 `midTurnSteer` 為 `true` 的有 Codex 與 Claude（分支 `feat/claude-mid-turn-steer`）。不支援的 provider 在生成中無法送出。
- `useChatRealtimeHandlers.ts` 處理 `complete` 與 `error`：`complete` 帶 `exitCode`，中斷時另帶 `aborted: true`；兩者都會把 `isLoading` 設回 `false`。
- `sessionStore.replaceSessionId(old, new)` 會在後端回報實際 session id 時替換。

這次只改前端。

## Goals / Non-Goals

**Goals:**
- 生成中送出改為排隊，所有 provider 都能用。
- 支援插話的 provider 在佇列項目上提供立即引導。
- 這一輪正常結束時自動送出佇列第一則；中斷、出錯時保留佇列。
- 佇列依會話隔離。

**Non-Goals:**
- 佇列持久化：重新整理頁面後佇列消失（只存在記憶體）。
- 編輯佇列項目、調整順序、一次合併多則送出。
- 立即引導的鍵盤快捷鍵。
- 帶圖片的插話（`chat-steer` 目前只傳文字）。
- 後端或 WebSocket 協議的任何修改。

## Decisions

### D1. 佇列存在一個模組層級的小 store，以會話為 key

專案沒有 Zustand（`useSessionStore` 是自寫 hook），所以不新增依賴，改用 React 內建的 `useSyncExternalStore`。新增 `src/stores/queuedMessagesStore.ts`：`Record<sessionKey, QueuedMessage[]>`，`QueuedMessage = { id, text, images: File[], steering: boolean }`，操作只有 `enqueue`、`remove`、`takeNext`、`setSteering`、`renameSession`；元件以 `useQueuedMessages(key)` 訂閱。

- **為何不用 hook 內的 `useState`**：切換會話時輸入框元件可能重新掛載或重設狀態，佇列需要跨會話保留。
- **為何不放進 `useSessionStore`**：那是訊息與同步的核心 store，佇列是純 UI 草稿，分開比較不會互相影響。
- **sessionKey**：`currentSessionId || selectedSession?.id`；新會話在拿到 id 之前用固定的 `'__new__'`。收到 `session_created`，或 `complete` 帶 `actualSessionId` 時，呼叫 `renameSession(old, new)` 搬移。

### D2. 送出流程拆成「排隊」與「開始新一輪」

`handleSubmit(event, queued?)` 多接受一個可選的佇列項目，而不是另外抽出 `startTurn`：現有流程中斜線指令攔截、清空輸入框、失敗還原草稿散落多處，抽函式的 diff 遠大於在這幾處判斷「是否為佇列項目」。

- 沒有 `queued`、生成中 → `enqueue` 目前輸入與附件，清空輸入框，結束。
- 沒有 `queued`、不在生成中 → 原流程不變。
- 有 `queued` → 以項目的 text 與 images 走「不在生成中」的流程（含斜線指令攔截、圖片上傳），但不清空也不還原輸入框（使用者可能正在寫下一則）；送出失敗時把項目放回佇列。
- 生成中的 `pendingCommand` 晶片：維持現狀，不能在生成中執行（送出按鈕對晶片仍停用）。

### D3. 「這一輪如何結束」由 realtime handler 通知

`useChatRealtimeHandlers` 在處理 `complete` / `error` 時，呼叫新的 callback `onTurnEnded(sessionId, outcome)`。`outcome` 規則如下：

- `complete` 且 `aborted !== true` 且 `exitCode` 為 0 或未定義 → `'completed'`
- `complete` 且 `aborted === true` → `'aborted'`
- 其他（`complete` 帶非 0 `exitCode`、`error`）→ `'error'`

輸入框狀態只在 `outcome === 'completed'`，而且 `sessionId` 是目前畫面上的會話時，才以 `takeNext` 取出第一則（跳過 `steering` 的項目）並送出。

- **為何不直接監聽 `isLoading` 變成 `false`**：`isLoading` 也會因 `check-session-status`、切換會話而變化，分不出中斷與錯誤，容易誤送。
- 送出時機用 `setTimeout(0)` 延到 `complete` 的狀態更新之後，避免 `startTurn` 在 `isLoading` 仍為 `true` 時被擋下。

### D4. 立即引導改從佇列項目觸發，接受後才加入對話

- 按下立即引導：`setSteering(key, id, true)`，送 `chat-steer { clientId: item.id }`；`pendingSteerRef` 改存佇列項目的 id 與 sessionKey。
- `steer-accepted`：從佇列移除該項目，此時才 `addMessage` 使用者訊息（不再先樂觀加入、被拒再移除，避免閃爍）。
- `steer-rejected`：`setSteering(key, id, false)`，項目留在佇列，加入一則錯誤訊息說明原因；`not_running` 時沿用現有的 `check-session-status` 校正。
- 同一時間仍只允許一則引導在等待回覆（其他項目的按鈕停用），沿用現有限制。
- 現有「生成中按送出就直接插話」的路徑移除。

### D5. UI

輸入框上方（`ClaudeStatus` 與 `PermissionRequestsBanner` 之下、輸入框之上）新增 `QueuedMessages` 子元件，列出目前會話的佇列。每列內容依序為：文字預覽（單行截斷）、圖片數量、操作按鈕、移除按鈕。操作按鈕依狀態顯示：

| 狀態 | 按鈕 |
| --- | --- |
| 生成中、provider 支援插話、項目無圖片 | 立即引導（等待回覆時顯示載入中） |
| 生成中、其他情況 | 無 |
| 不在生成中 | 送出 |

送出按鈕在生成中只要有文字或圖片就可按，`title` 顯示「會在這一輪結束後送出」。i18n 在 `chat.json` 的 `steer` 區塊新增 `queued`、`steerNow`、`sendNow`、`remove`、`steering`、`imageOnly`，並改寫 `hint` 與 `rejected`（被拒的訊息留在佇列，不再是「輸入已保留」）；八種語系都要補。

## Risks / Trade-offs

- [習慣「Enter 直接插話」的使用者需要多按一次] → 這是刻意對齊 Codex / Gemini App 的行為；送出按鈕提示與佇列項目上的按鈕說明新行為。
- [自動送出和立即引導搶同一則] → 自動送出跳過 `steering` 的項目；引導被拒後項目回到 idle，由使用者手動處理。
- [新會話在拿到 id 前排隊，`'__new__'` 搬移失敗會讓佇列留在暫時 key 上] → `renameSession` 在 `session_created` 與 `actualSessionId` 替換兩處都呼叫。若新會話在拿到 id 前就失敗，項目會留在 `'__new__'`，下一個新會話會看到它們；刻意不清除，因為那是使用者寫好、尚未送出的內容。
- [重新整理後佇列遺失] → 列為 Non-Goal；佇列是短暫的草稿，丟失的代價低。若之後有需求，再存到 `sessionStorage`。
- [中斷與錯誤判斷依賴 `complete` 的 `aborted`、`exitCode` 欄位] → 各 runtime 已依 dispatcher 規則送出這些欄位；實作時為 `onTurnEnded` 的判斷寫單元測試。

## Migration Plan

純前端行為變更，隨版本發布即生效；回滾 revert 即可。不影響後端或已存的會話資料。

## Open Questions

- 佇列中有項目時，空的輸入框按 Enter 是否要觸發「立即引導第一則」？目前不做，維持只有按鈕觸發。
