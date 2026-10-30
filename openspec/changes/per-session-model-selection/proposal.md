## Why

輸入框右下角的模型選擇器（`ModelSelector`）目前讀寫的是全域 localStorage（`claude-model` / `codex-model` / `cursor-model` / `gemini-model` / `antigravity-model`）。使用者在新 session 中切換模型後，再打開任何存量 session，都會沿用這個新模型繼續對話；當新模型與該 session 原本使用的模型不相容（例如跨模型族 resume、Codex/Antigravity 模型不支援既有 thread），就會直接報錯。模型選擇應該跟隨 session，而不是全域共享。

## What Changes

- 模型選擇改為「按 session 記憶」：每個已存在的 session 各自保存最後使用的模型，存在後端資料庫（`~/.cloudcli/auth.db` 的 `session_models` 表），跨 app 重啟、版本升級、桌面端/瀏覽器保留。
- 切換到某個 session 時，右下角選擇器顯示並使用該 session 記錄的模型；沒有記錄的存量 session 回退到 provider 的全域預設模型。
- 在**已有 session** 中切換模型，只更新該 session 的記錄，**不再**改寫全域預設，避免汙染其他 session。
- 在**新 session**（尚無 sessionId）中切換模型，仍寫入全域預設（作為「下一個新 session 的預設模型」）；新 session 建立（`session_created`）時即綁定首次發送所用的模型，之後每次發送也會更新該 session 的記錄。
- 回到新 session 畫面時，選擇器重新顯示全域預設模型，而不是上一個 session 的模型。

## Capabilities

### New Capabilities
- `per-session-model-selection`: 聊天輸入框模型選擇的作用域規則——已有 session 的模型按 session 保存與還原，新 session 使用全域預設，session 建立時綁定所用模型。

### Modified Capabilities
<!-- 無：openspec/specs/ 下沒有涵蓋模型選擇的既有 spec -->

## Impact

- 後端：
  - `server/modules/database/schema.ts`：新增 `session_models` 表（`CREATE TABLE IF NOT EXISTS`，無需遷移腳本）。
  - `server/modules/database/repositories/sessions.db.ts`：`getSessionModel` / `setSessionModel`。
  - `server/modules/providers/services/sessions.service.ts`、`provider.routes.ts`：`GET/PUT /api/providers/sessions/:sessionId/model`。
- 前端：
  - `src/utils/api.js`：`getSessionModel` / `setSessionModel`。
  - `src/components/chat/utils/chatStorage.ts`：`saveSessionModel`。
  - `src/components/chat/hooks/useChatProviderState.ts`：切換 session 時從 API 還原模型；Codex/Antigravity 清單校驗不再回寫 session 記錄。
  - `src/components/chat/hooks/useChatComposerState.ts`：`handleModelSwitch` 依是否有 session 寫入 API 或全域 key；發送時寫入 session 模型。
  - `src/components/chat/hooks/useChatRealtimeHandlers.ts`：`session_created` 時寫入新 session 的模型。
- 相容性：新增表與 API，不改既有資料；全域 localStorage key 保留作為新 session 預設與無記錄 session 的回退值。
