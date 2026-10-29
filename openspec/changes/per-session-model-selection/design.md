## Context

模型狀態集中在 `useChatProviderState`：五個 provider 各一個 `useState`，初始值讀全域 localStorage（`<provider>-model`）。寫入點有兩處：

- `useChatComposerState.handleModelSwitch`（輸入框右下角 `ModelSelector`、`/model <name>` 指令）
- `ProviderSelectionEmptyState`（新 session 空白頁的模型選擇）

兩處都同時 `setXxxModel` 並寫全域 key。切換 session 時沒有任何邏輯重設模型，所以 React state 與 localStorage 都保留最後一次的選擇，存量 session resume 時把這個模型送給後端（`claude-command` / `codex-command` 等的 `options.model`），導致模型不一致報錯。

同一個 hook 已經有可參照的先例：`permissionMode` 依 `selectedSession.id` 從 `permissionMode-<sessionId>` 還原，切換時寫回。

## Goals / Non-Goals

**Goals:**
- 已有 session 的模型選擇只影響該 session，切換 session 時自動還原。
- 新 session 的模型選擇延續為「全域預設」，給下一個新 session 用。
- 改動限制在前端兩個 hook，不動後端與資料結構。

**Non-Goals:**
- 從 session 歷史（如 Claude jsonl 的 `message.model`）回推存量 session 的原始模型。目前 session 列表與訊息正規化都不帶模型欄位，要做須改後端；本次以全域預設回退。
- 跨裝置/跨瀏覽器同步（localStorage 本就是單機）。
- 清理過期 session 的 localStorage key（與 `permissionMode-*` 現狀一致，量級小）。

## Decisions

1. **儲存位置：localStorage `session-model-<sessionId>`**
   沿用 `permissionMode-<sessionId>` 模式，零後端改動。session 只屬於一個 provider，所以 key 不需要帶 provider。
   替代方案：存進 DB / session metadata——能跨裝置，但要新增 API 與遷移，對這個 bug 屬過度設計。

2. **還原時機：`useChatProviderState` 中依 `[selectedSession?.id, provider]` 的 effect**
   - 有 sessionId 且有記錄 → 設為記錄值。
   - 有 sessionId 但無記錄 → 設為全域 `<provider>-model`（缺省則 `XXX_MODELS.DEFAULT`）。
   - 無 sessionId（新 session 畫面）→ 設為全域預設。
   只設定 `session.__provider` 對應的那個 provider 的 model state。依賴 `provider` 是因為選擇 session 時 provider 可能在另一個 effect 中才切換過來。

3. **寫入規則：`handleModelSwitch` 依是否有 `selectedSession?.id` 分流**
   - 有 → 只寫 `session-model-<id>`，不動全域 key。
   - 無 → 照舊寫全域 key。
   `ProviderSelectionEmptyState` 只出現在無 session 時，維持寫全域 key，不需改。

4. **新 session 綁定：發送時落盤，而非監聽 `session_created`**
   在 `handleSubmit` 發送訊息時，若 `effectiveSessionId` 存在就寫 `session-model-<id>` = 本次送出的模型。新 session 首次發送時尚無 id，但 `session_created` 後還原 effect 會讀到全域預設——它正好等於使用者在新 session 畫面選的模型——第二次發送後即落盤。
   這也讓存量 session 在升級後第一次發送就被綁定。
   替代方案：在 `useChatRealtimeHandlers` 的 `session_created` 分支寫入——需要把五個 model 傳進 realtime handler，耦合更多，收益相同。

## Risks / Trade-offs

- [存量 session 無記錄時回退全域預設，仍可能不是原始模型] → 使用者在該 session 手動切一次即被記住；若需要徹底解決，後續可在 session 列表回傳最後使用的模型（見 Open Questions）。
- [新 session 首次發送後、第二次發送前，若使用者在另一分頁改了全域預設，回到此 session 會拿到新的全域值] → 機率極低；可接受。
- [Codex / Antigravity 的模型清單校驗 effect 可能把還原的 session 模型改成清單首項] → 該 effect 只在模型不在可用清單時改寫，屬正確行為；但它目前也會寫全域 key，需確認只在無 session 時寫全域、有 session 時寫 session key。

## Migration Plan

純前端改動，無資料遷移。回滾即還原兩個 hook；殘留的 `session-model-*` key 不影響舊版行為。

## Open Questions

- 是否要做後端支援：在 session 列表/詳情中回傳最後使用的模型（Claude 讀 jsonl 最後一條 assistant 的 `message.model`，Codex 讀 thread 設定），作為無本地記錄時的回退值？建議等本次上線後視回報再決定。
