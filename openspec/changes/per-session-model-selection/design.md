## Context

模型狀態集中在 `useChatProviderState`：五個 provider 各一個 `useState`，初始值讀全域 localStorage（`<provider>-model`）。寫入點有兩處：

- `useChatComposerState.handleModelSwitch`（輸入框右下角 `ModelSelector`、`/model <name>` 指令）
- `ProviderSelectionEmptyState`（新 session 空白頁的模型選擇）

兩處都同時 `setXxxModel` 並寫全域 key。切換 session 時沒有任何邏輯重設模型，存量 session resume 時把最後一次選的模型送給後端（`claude-command` / `codex-command` 等的 `options.model`），導致模型不一致報錯。

## Goals / Non-Goals

**Goals:**
- 已有 session 的模型選擇只影響該 session，切換 session 時自動還原。
- 記錄跨 app 重啟、版本升級、桌面端/瀏覽器保留。
- 新 session 的模型選擇延續為「全域預設」，給下一個新 session 用。

**Non-Goals:**
- 從 session 歷史（如 Claude jsonl 的 `message.model`）回推改動前存量 session 的模型：jsonl 記錄的 ID（`claude-opus-5-5-hc-yd`）與選擇器值（`anthropic/claude-opus-5-5-hc-yd`）格式不一致，映射不穩定。
- 全域預設模型與其他前端設定的持久化（仍在 localStorage）；桌面端 origin 隨 port 變動的問題另案處理。

## Decisions

1. **儲存位置：後端 SQLite 新表 `session_models(session_id PK, model, updated_at)`**
   資料庫在 `~/.cloudcli/auth.db`，位於 app 安裝目錄之外，升級、重啟都保留；不受瀏覽器或桌面端 origin 影響。
   - 替代方案 A：localStorage `session-model-<id>`（最初實作）——localStorage 依 origin 隔離，而桌面端每次啟動以隨機 port 載入頁面，重啟後所有記錄失效，實測證實等於白做。
   - 替代方案 B：桌面端沿用上次 port 以固定 origin——port 被佔用時會靜默換 origin、資料讀不到，且只解決桌面端；放棄。
   - 替代方案 C：在 `sessions` 表加 `model` 欄位——新 session 在 `session_created` 時就要寫入，此時 Claude 的 `sessions` 列可能尚未由同步器建立；用 INSERT 補不完整的列又可能干擾同步。獨立表無外鍵，無此問題。
   - 替代方案 D：放進 `app_config` 鍵值表——該表存 JWT secret 等機密，不宜混入 session 資料。

2. **API：`GET/PUT /api/providers/sessions/:sessionId/model`**
   沿用既有 `PUT /sessions/:sessionId`（改名）的路由與 service 分層。PUT 不檢查 `sessions` 列是否存在（理由同 1-C）。

3. **還原：`useChatProviderState` 依 `[selectedSession?.id, provider]` 的 effect 非同步讀取**
   - 有 sessionId → GET；有記錄用記錄，無記錄或請求失敗回退全域預設。
   - 無 sessionId（新 session 畫面）→ 直接設為全域預設。
   - session 屬於另一個 provider 時先跳過，等 provider 切過去再還原；effect 清理時丟棄過期回應。

4. **寫入規則**
   - `handleModelSwitch`：有 `selectedSession?.id` → PUT；否則寫全域 key。
   - 新 session 首次發送時尚無 id，`handleSubmit` 先把所用模型暫存到 sessionStorage `pendingSessionModel`（與既有 `pendingSessionId` 同一做法）；`useChatRealtimeHandlers` 收到 `session_created` 時 PUT 並清除暫存。
   - 之後每次對已有 session 發送都以當下模型 PUT，順帶綁定改動前的存量 session。
   實測教訓：最初只靠「第二次發送」綁定，但只發過一則訊息的 session（後續回合由背景任務 `task-notification` 驅動，不經過 `handleSubmit`）永遠沒有記錄。

5. **Codex / Antigravity 模型清單校驗不回寫 session 記錄**
   還原改為非同步後，校驗 effect 可能先於還原拿到「上一個 session 的模型」，若此時把清單首項寫回就會覆蓋正確記錄。因此有 session 時只調整顯示值，只有新 session 畫面才寫全域 key。

## Risks / Trade-offs

- [打開 session 後、GET 回來前的極短時間內，選擇器仍顯示前一個值] → 本機請求通常數十毫秒內完成；可接受。
- [GET 回來前使用者已在該 session 手動切換，回應會覆蓋其選擇] → 時間窗極小；可接受。
- [改動前建立、從未在其中發送或切換過的存量 session 沒有記錄，仍回退全域預設] → 在該 session 切換一次或發送一則即被記住。
- [`session_models` 不隨 session 刪除清理] → 每列僅數十位元組，無功能影響；需要時在刪除 session 時一併刪除。

## Migration Plan

`session_models` 以 `CREATE TABLE IF NOT EXISTS` 加入 `INIT_SCHEMA_SQL`，啟動時自動建立，舊資料庫無需遷移腳本。回滾時舊版忽略該表即可。開發期曾寫入的 localStorage `session-model-*` 不遷移（功能未發布）。

## Open Questions

- 無。
