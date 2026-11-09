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

### D1. 佇列存在一個小的 Zustand store，以會話為 key

`src/stores/` 已經使用 Zustand。新增 `useQueuedMessagesStore`：`Record<sessionKey, QueuedMessage[]>`，`QueuedMessage = { id, text, images: File[], steerState: 'idle' | 'pending' }`，操作只有 `enqueue`、`remove`、`shift`、`setSteerState`、`renameSession`。

- **為何不用 hook 內的 `useState`**：切換會話時輸入框元件可能重新掛載或重設狀態，佇列需要跨會話保留。
- **為何不放進 `useSessionStore`**：那是訊息與同步的核心 store，佇列是純 UI 草稿，分開比較不會互相影響。
- **sessionKey**：`currentSessionId || selectedSession?.id`；新會話在拿到 id 之前用固定的 `'__new__'`。收到 `session_created`，或 `complete` 帶 `actualSessionId` 時，呼叫 `renameSession(old, new)` 搬移。

### D2. 送出流程拆成「排隊」與「開始新一輪」

把 `handleSubmit` 中「上傳圖片 → 加入使用者訊息 → 送 `claude-command` 等」這一段抽成 `startTurn({ text, images })`。

- `handleSubmit`：生成中 → `enqueue`，清空輸入框與附件，結束。不在生成中 → 維持原流程（斜線指令攔截、`pendingCommand` 晶片等），最後呼叫 `startTurn`。
- 自動送出與手動送出佇列項目，都走與 `handleSubmit` 相同的「不在生成中」分支（以項目的 text 與 images 為輸入），所以斜線指令與圖片行為和一般送出一致。
- 生成中的 `pendingCommand` 晶片：維持現狀，不能在生成中執行（送出按鈕對晶片仍停用）。

### D3. 「這一輪如何結束」由 realtime handler 通知

`useChatRealtimeHandlers` 在處理 `complete` / `error` 時，呼叫新的 callback `onTurnEnded(sessionId, outcome)`。`outcome` 規則如下：

- `complete` 且 `aborted !== true` 且 `exitCode` 為 0 或未定義 → `'completed'`
- `complete` 且 `aborted === true` → `'aborted'`
- 其他（`complete` 帶非 0 `exitCode`、`error`）→ `'error'`

輸入框狀態只在 `outcome === 'completed'`，而且 `sessionId` 是目前畫面上的會話時，才 `shift` 第一則（跳過 `steerState === 'pending'` 的項目）並送出。

- **為何不直接監聽 `isLoading` 變成 `false`**：`isLoading` 也會因 `check-session-status`、切換會話而變化，分不出中斷與錯誤，容易誤送。
- 送出時機用 `setTimeout(0)` 延到 `complete` 的狀態更新之後，避免 `startTurn` 在 `isLoading` 仍為 `true` 時被擋下。

### D4. 立即引導改從佇列項目觸發，接受後才加入對話

- 按下立即引導：`setSteerState(id, 'pending')`，送 `chat-steer { clientId: item.id }`；`pendingSteerRef` 改存佇列項目的 id 與 sessionKey。
- `steer-accepted`：從佇列移除該項目，此時才 `addMessage` 使用者訊息（不再先樂觀加入、被拒再移除，避免閃爍）。
- `steer-rejected`：`setSteerState(id, 'idle')`，項目留在佇列，加入一則錯誤訊息說明原因；`not_running` 時沿用現有的 `check-session-status` 校正。
- 同一時間仍只允許一則引導在等待回覆（其他項目的按鈕停用），沿用現有限制。
- 現有「生成中按送出就直接插話」的路徑移除。

### D5. UI

輸入框上方（`ClaudeStatus` 與 `PermissionRequestsBanner` 之下、輸入框之上）新增 `QueuedMessages` 子元件，列出目前會話的佇列。每列內容依序為：文字預覽（單行截斷）、圖片數量、操作按鈕、移除按鈕。操作按鈕依狀態顯示：

| 狀態 | 按鈕 |
| --- | --- |
| 生成中、provider 支援插話、項目無圖片 | 立即引導（等待回覆時顯示載入中） |
| 生成中、其他情況 | 無 |
| 不在生成中 | 送出 |

送出按鈕在生成中只要有文字或圖片就可按，`title` 顯示「會在這一輪結束後送出」。i18n 在 `chat.json` 的 `steer` 區塊新增 `queued`、`steerNow`、`sendNow`、`remove`、`queuedHint`，並改寫 `hint`；八種語系都要補。

## Risks / Trade-offs

- [習慣「Enter 直接插話」的使用者需要多按一次] → 這是刻意對齊 Codex / Gemini App 的行為；送出按鈕提示與佇列項目上的按鈕說明新行為。
- [自動送出和立即引導搶同一則] → 自動送出跳過 `steerState === 'pending'` 的項目；引導被拒後項目回到 idle，由使用者手動處理。
- [新會話在拿到 id 前排隊，`'__new__'` 搬移失敗會讓佇列留在暫時 key 上] → `renameSession` 在 `session_created` 與 `actualSessionId` 替換兩處都呼叫；切到新會話時清掉 `'__new__'` 中已無主的項目。
- [重新整理後佇列遺失] → 列為 Non-Goal；佇列是短暫的草稿，丟失的代價低。若之後有需求，再存到 `sessionStorage`。
- [中斷與錯誤判斷依賴 `complete` 的 `aborted`、`exitCode` 欄位] → 各 runtime 已依 dispatcher 規則送出這些欄位；實作時為 `onTurnEnded` 的判斷寫單元測試。

## Migration Plan

純前端行為變更，隨版本發布即生效；回滾 revert 即可。不影響後端或已存的會話資料。

## Open Questions

- 佇列中有項目時，空的輸入框按 Enter 是否要觸發「立即引導第一則」？目前不做，維持只有按鈕觸發。
