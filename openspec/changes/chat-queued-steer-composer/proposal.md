## Why

目前生成中按送出，支援插話的 provider（Codex、Claude）會立刻把訊息插進這一輪，不支援的 provider 則直接擋住送出按鈕。使用者沒有「先寫好、等這一輪結束再送」的選項，也沒辦法在送出後反悔。

Codex App、Gemini（Antigravity）App 的做法一致：生成中送出的訊息先停在輸入框上方排隊，旁邊有「立即引導」按鈕，按了才插進正在執行的這一輪（不中斷模型）；不按就等這一輪結束後自動送出。我們要對齊這個體驗。

## What Changes

- 生成中送出的訊息不再直接插話，改為進入**待送佇列**，顯示在輸入框上方（文字預覽、移除按鈕）。所有 provider 都適用，包含不支援插話的 Cursor。
- provider 支援插話（`midTurnSteer`）時，佇列中每則訊息旁顯示**立即引導**按鈕，按下才走現有的 `chat-steer`；成功後從佇列移除並出現在對話中，失敗則留在佇列並顯示原因。
- 這一輪**正常結束**後，自動把佇列第一則當作新一輪送出；其餘留在佇列，依序在後續每一輪結束後送出。
- 這一輪是被**中斷**或**出錯**結束時，不自動送出，佇列保留，由使用者手動送出或移除。
- 送出按鈕在生成中保持可用（文字為空時除外），提示文字改為「會在這一輪結束後送出」。
- 後端與 WebSocket 協議不變；`chat-steer`、`steer-accepted`、`steer-rejected` 沿用。

## Capabilities

### New Capabilities
- `chat-queued-messages`: 生成中送出訊息的待送佇列、立即引導、這一輪結束後的自動送出，以及中斷、出錯、切換會話時的佇列行為。

### Modified Capabilities
（無。`openspec/specs/` 目前沒有涵蓋聊天輸入框或插話的既有規格。）

## Impact

- 前端：`src/components/chat/hooks/useChatComposerState.ts`（送出流程拆成「排隊」與「實際送出」、佇列狀態、立即引導、這一輪結束時自動送出）、`src/components/chat/view/subcomponents/ChatComposer.tsx`（佇列列表、送出按鈕狀態與提示）、可能新增一個 `QueuedMessages` 子元件；`useChatRealtimeHandlers.ts` 需要把「這一輪如何結束」（正常／中斷／錯誤）告訴輸入框狀態。
- i18n：`src/i18n/locales/*/chat.json` 的 `steer` 區塊新增佇列相關文案，既有 `steer.hint` 改寫。
- 後端：不需修改。
- 相依：Antigravity 要等 `antigravity-acp-interactive-approvals` 完成、開啟 `midTurnSteer` 後才會出現立即引導按鈕；在那之前它只有排隊。
