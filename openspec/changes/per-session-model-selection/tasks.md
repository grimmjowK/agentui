## 1. 後端儲存

- [x] 1.1 `schema.ts` 新增 `session_models(session_id PK, model, updated_at)` 並加入 `INIT_SCHEMA_SQL`
- [x] 1.2 `sessionsDb.getSessionModel` / `setSessionModel`（upsert，不依賴 `sessions` 列）
- [x] 1.3 `sessionsService` 與 `GET/PUT /api/providers/sessions/:sessionId/model` 路由，PUT 驗證 model 為 1–200 字元字串
- [x] 1.4 `sessions.db.integration.test.ts` 補 session model upsert 測試

## 2. 前端還原（useChatProviderState）

- [x] 2.1 新增依 `[selectedSession?.id, provider]` 的 effect：有 session 時 GET，無記錄或失敗回退全域預設；無 session 時設為全域預設；丟棄過期回應
- [x] 2.2 Codex / Antigravity 模型清單校驗：有 session 時只調整顯示值不回寫，無 session 才寫全域 key

## 3. 前端寫入

- [x] 3.1 `src/utils/api.js` 新增 `getSessionModel` / `setSessionModel`；`chatStorage.ts` 新增 `saveSessionModel`（失敗只記 log）
- [x] 3.2 `handleModelSwitch`：有 session 時 PUT，否則寫全域 key
- [x] 3.3 `handleSubmit`：新 session 暫存 `pendingSessionModel`；已有 session 發送時 PUT 當下模型
- [x] 3.4 `useChatRealtimeHandlers` 收到 `session_created` 時 PUT 暫存模型並清除
- [x] 3.5 確認 `ProviderSelectionEmptyState` 只在無 session 時出現、維持寫全域 key，無需修改

## 4. 驗證

- [x] 4.1 `npm run typecheck`、`npm run lint`（0 error）、sessions DB 整合測試通過
- [x] 4.2 `npm run build` 通過
- [ ] 4.3 手動驗證：新 session 以 Y 建立（只發一則）→ 新 session 畫面切到 X → 打開該 session 顯示 Y 且發送不報錯
- [ ] 4.4 手動驗證：在 session A 切到 X → 回到新 session 畫面顯示全域預設（非 X）→ 打開 session B 顯示 B 的模型
- [ ] 4.5 手動驗證（桌面端 dmg）：重啟 app 後，上述 session 仍顯示各自的模型
- [ ] 4.6 手動驗證：Codex / Antigravity 各走一次 4.3，確認清單校驗不會覆寫 session 模型
