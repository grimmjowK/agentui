## 1. 模型還原（useChatProviderState）

- [x] 1.1 新增 helper：依 provider 取得全域預設模型（`localStorage.getItem('<provider>-model') || XXX_MODELS.DEFAULT`）與對應的 setter，避免五段 if/else 重複散落
- [x] 1.2 新增依 `[selectedSession?.id, provider]` 的 effect：有 sessionId 時讀 `session-model-<id>`，無記錄則回退全域預設；無 sessionId 時設為全域預設；只更新當前 provider 的 model state
- [x] 1.3 調整 Codex / Antigravity 模型清單校驗 effect：模型不在清單時，有 session 寫 `session-model-<id>`，無 session 才寫全域 key

## 2. 模型寫入（useChatComposerState）

- [x] 2.1 `handleModelSwitch`：有 `selectedSession?.id` 時只寫 `session-model-<id>`，否則照舊寫全域 key；React state 更新邏輯不變
- [x] 2.2 `handleSubmit` 發送訊息時，若 `effectiveSessionId` 存在，寫入 `session-model-<effectiveSessionId>` = 本次送出的模型
- [x] 2.3 確認 `ProviderSelectionEmptyState` 只在無 session 時出現、維持寫全域 key，無需修改

## 3. 驗證

- [x] 3.1 `npm run typecheck`、`npm run lint`、`npm run build` 通過
- [ ] 3.2 手動驗證：新 session 切到模型 X → 打開記錄為 Y 的存量 session，選擇器顯示 Y 且發送不報錯
- [ ] 3.3 手動驗證：在存量 session A 切到 X → 回到新 session 畫面顯示全域預設（非 X）→ 打開 session B 顯示 B 的模型
- [ ] 3.4 手動驗證：新 session 以 X 建立並再發一則 → 新 session 畫面改全域為 Z → 重開該 session 顯示 X
- [ ] 3.5 手動驗證：Codex / Antigravity 各走一次 3.2，確認清單校驗不會覆寫 session 模型為全域值
