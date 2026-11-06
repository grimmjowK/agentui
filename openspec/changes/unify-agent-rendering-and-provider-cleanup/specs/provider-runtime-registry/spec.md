## ADDED Requirements

### Requirement: 執行層屬於 provider 介面
每個已註冊的 provider SHALL 提供 runtime 介面，包含啟動一輪對話、中斷、查詢是否執行中、重新接上 writer、列出執行中會話；插話（`steer`）與查詢待審批請求（`getPendingApprovals`）為可選方法。聊天 WebSocket 服務、HTTP agent 路由與伺服器入口 MUST 透過 provider registry 取得 runtime，MUST NOT 直接匯入或列舉各家的執行函式。

#### Scenario: 新增 provider 不需修改分派程式
- **WHEN** registry 新註冊一個實作了 runtime 介面的 provider
- **THEN** 不需修改 `chat-websocket.service.ts`、`routes/agent.js`、`server/index.js`，該 provider 就能透過聊天頁與 agent API 啟動對話

### Requirement: 單一聊天指令訊息
系統 SHALL 以單一 WebSocket 訊息 `chat-command { provider, command, options }` 啟動任何 provider 的對話；MUST NOT 再接受 `claude-command`、`cursor-command`、`codex-command`、`antigravity-command`、`cursor-resume` 等按 provider 區分的訊息。未註冊的 provider MUST 回傳錯誤，不得退回預設 provider。

#### Scenario: 送出到指定 provider
- **WHEN** 前端送出 `chat-command`，`provider` 為 `antigravity`
- **THEN** 後端呼叫 Antigravity 的 runtime 啟動這一輪

#### Scenario: 未註冊的 provider
- **WHEN** 前端送出 `chat-command`，`provider` 為 `gemini`
- **THEN** 後端回傳錯誤訊息，不啟動任何 provider

#### Scenario: Cursor 續接
- **WHEN** 前端送出 `chat-command`，`provider` 為 `cursor`、`options.resume` 為 `true`、指令為空
- **THEN** 行為與原本的 `cursor-resume` 相同

### Requirement: 中斷只產生一個結束事件
系統 SHALL 透過 `abort-session { provider, sessionId }` 中斷任何 provider 的對話，且每次中斷 MUST 只產生一個結束事件：runtime 自行送出結束事件時，分派層 MUST NOT 補送；runtime 不送時，分派層 MUST 補送一次 `complete`（`aborted: true`）。

#### Scenario: Claude 中斷
- **WHEN** 使用者中斷一個執行中的 Claude 對話
- **THEN** 前端只收到一個 `aborted: true` 的 `complete` 事件

#### Scenario: Codex 中斷
- **WHEN** 使用者中斷一個執行中的 Codex 對話
- **THEN** 前端只收到 Codex runtime 送出的那一個結束事件

### Requirement: 狀態查詢與執行中會話列表依 registry
系統 SHALL 依 registry 處理 `check-session-status` 與 `get-active-sessions`：狀態查詢 MUST 呼叫該 provider 的 runtime（支援重新接上的 provider 同時把 writer 接回）；執行中會話列表的鍵 MUST 為已註冊的 provider id。

#### Scenario: 重新整理後接回執行中的對話
- **WHEN** Codex 或 Antigravity 對話執行中，使用者重新整理頁面
- **THEN** 狀態查詢回報執行中，後續串流訊息送到新的連線

#### Scenario: 執行中會話列表
- **WHEN** 前端送出 `get-active-sessions`
- **THEN** 回應的鍵只包含已註冊的 provider，不包含 `gemini`

### Requirement: 前端單一送出路徑
前端 SHALL 以單一路徑組裝並送出 `chat-command`、`abort-session`、`check-session-status`；各 provider 的參數差異（權限模式映射、是否帶 effort、是否帶圖片）MUST 由 provider 資訊表決定，MUST NOT 在送出邏輯中以 `provider === '<id>'` 分支。

#### Scenario: Codex 的 plan 模式映射
- **WHEN** 使用者在 Codex 下以 plan 權限模式送出
- **THEN** 送出的 `permissionMode` 為 `default`，與現有行為相同，且此映射來自資訊表

#### Scenario: 圖片只送給支援的 provider
- **WHEN** 使用者附上圖片並送出到資訊表中 `images` 為 `false` 的 provider
- **THEN** 送出的 options 不帶圖片
