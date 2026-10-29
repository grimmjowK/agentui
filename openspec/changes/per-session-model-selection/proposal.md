## Why

輸入框右下角的模型選擇器（`ModelSelector`）目前讀寫的是全域 localStorage（`claude-model` / `codex-model` / `cursor-model` / `gemini-model` / `antigravity-model`）。使用者在新 session 中切換模型後，再打開任何存量 session，都會沿用這個新模型繼續對話；當新模型與該 session 原本使用的模型不相容（例如跨模型族 resume、Codex/Antigravity 模型不支援既有 thread），就會直接報錯。模型選擇應該跟隨 session，而不是全域共享。

## What Changes

- 模型選擇改為「按 session 記憶」：每個已存在的 session 各自保存最後使用的模型（localStorage key `session-model-<sessionId>`），沿用現有 `permissionMode-<sessionId>` 的同一套做法。
- 切換到某個 session 時，右下角選擇器顯示並使用該 session 記錄的模型；沒有記錄的存量 session 回退到 provider 的全域預設模型。
- 在**已有 session** 中切換模型，只更新該 session 的記錄，**不再**改寫全域預設，避免汙染其他 session。
- 在**新 session**（尚無 sessionId）中切換模型，仍寫入全域預設（作為「下一個新 session 的預設模型」）；對已有 session 發送訊息時，把本次使用的模型落盤到該 session 的記錄。
- 回到新 session 畫面時，選擇器重新顯示全域預設模型，而不是上一個 session 的模型。

## Capabilities

### New Capabilities
- `per-session-model-selection`: 聊天輸入框模型選擇的作用域規則——已有 session 的模型按 session 保存與還原，新 session 使用全域預設，發送訊息時綁定 session 所用模型。

### Modified Capabilities
<!-- 無：openspec/specs/ 下沒有涵蓋模型選擇的既有 spec -->

## Impact

- 前端：
  - `src/components/chat/hooks/useChatProviderState.ts`：新增依 `selectedSession.id` / provider 還原模型的 effect；Codex/Antigravity 模型清單校驗改為依 session 決定寫入哪個 key。
  - `src/components/chat/hooks/useChatComposerState.ts`：`handleModelSwitch` 依是否有 session 決定寫入 session key 或全域 key；發送時寫入 session 模型記錄。
  - `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx`：新 session 畫面的模型切換維持寫全域預設（行為不變，確認即可）。
- 後端、API、資料庫：無改動。
- 相容性：不破壞既有資料；舊的全域 key 保留作為新 session 預設與存量 session 回退值。
