## 1. 實測與錄製（先於實作，結論記入 design.md）

- [ ] 1.1 以真實 `agy acp` 錄製四段協議記錄到 `docs/fixtures/antigravity/acp-*.jsonl`：允許、拒絕、審批中 `session/cancel`、`session/resume` 續接；確認 `tool_call_update` 完成時的結果內容形狀，以及被拒絕後模型是繼續回覆還是結束這一輪
- [ ] 1.2 實測模型設定方式（`session/set_model`、`configOptions` 或 `--model`），以及 `agy acp --dangerously-skip-permissions` 是否有效；未登入時 `initialize` / `session/new` 的錯誤形狀（可用暫時的空設定目錄模擬）
- [ ] 1.3 把 1.1–1.2 的結論寫進 design.md 的 Open Questions，並據此修正 D3、D6、D7

## 2. 協議連線與事件映射

- [ ] 2.1 在 Antigravity 模組內新增 ACP JSON-RPC over stdio 連線類別：請求逾時、行程退出時 reject 所有未完成請求、stderr 只當診斷、`protocolVersion` 不是 1 時回報錯誤；以假行程寫單元測試（片段行、交錯的伺服器請求、行程意外退出）
- [ ] 2.2 在 `antigravity-tool-mapper.ts` 新增 `mapAcpUpdate`，依 design D3 的對照表輸出標準訊息，工具名稱與參數沿用 `mapAgyTool`；以 1.1 的 fixture 寫測試

## 3. 審批池

- [ ] 3.1 新增 Antigravity 審批池：新增（綁定 `userId`、`sessionId`、執行個體，產生 `permission_request`，`context.decisions` 由 ACP `options` 轉換、`context.expiresAt`）、決定（嚴格比對使用者與可選決定）、逾時回覆拒絕並送 `permission_cancelled`、依執行個體清除、依使用者列出
- [ ] 3.2 為審批池寫測試：其他使用者決定被拒、缺少 `userId` 被拒、決定不在選項內被拒、逾時回覆 `deny`、清除時回覆已取消、列出只含該使用者

## 4. 執行層替換

- [ ] 4.1 改寫 `server/antigravity-cli.js`：每輪啟動 `agy acp` → `initialize` → `session/new` 或 `session/resume` → 依權限模式 `session/set_mode`（或依 1.2 的結論處理 bypass）→ 設定模型 → `session/prompt`；`session/update` 經 `mapAcpUpdate` 轉送；`session/request_permission` 進審批池；收到 `stopReason` 後送一次 `complete` 並結束行程
- [ ] 4.2 中斷：`session/cancel` → 回覆未決審批為已取消 → 等待 `stopReason: cancelled`，7 秒內未返回就結束行程；`runtime.abort` 回傳 `emitsTerminal: true`
- [ ] 4.3 錯誤處理：未登入、初始化失敗、行程意外退出、JSON-RPC 錯誤時送出明確 `error`、清除待審批、送出結束事件；移除臨時修正 `findPermissionDeniedNotice` 及其測試
- [ ] 4.4 `antigravity-runtime.provider.ts` 接上 `getPendingApprovals` 與 `resolveApproval`；保留新會話的 `session_created`、結束後立即同步 transcript 的現有行為

## 5. WebSocket 與前端

- [ ] 5.1 `chat-websocket.service.ts` 新增 `permission-decision { provider, requestId, sessionId, decision }`，分派到 `runtime.resolveApproval`；provider 未實作或被拒時回覆警告；新增測試
- [ ] 5.2 前端審批卡片與送出邏輯改為依 `context.decisions` 判斷（不新增 `provider === 'antigravity'`），Antigravity 送 `permission-decision`，Codex 維持 `codex-permission-response`；補 Antigravity 決定的 i18n（允許／拒絕）
- [ ] 5.3 `shared/providers.ts` 的 Antigravity `permissionModes` 改為 `default`、`acceptEdits`、`plan`、`bypassPermissions`，預設模式邏輯維持「明確同意才預設 bypass」；確認權限模式按鈕的說明文字與 i18n

## 6. 驗收（全部在瀏覽器實測，`npm run dev`；任一項不通過即不算完成）

- [ ] 6.1 預設模式請 Antigravity 執行 `ls -la`：出現審批卡片（顯示 Bash 與指令、到期時間）→ 允許 → 工具結果與回覆正常、這一輪結束
- [ ] 6.2 同樣情境按拒絕：工具卡片顯示被拒、頁面不停在「處理中」
- [ ] 6.3 審批卡片顯示時重新整理頁面：收件匣與卡片仍在，允許後正常執行
- [ ] 6.4 審批等待中切到其他會話：其他會話不顯示卡片，收件匣可跳回並完成審批
- [ ] 6.5 審批卡片顯示時按停止：卡片與收件匣項目消失，頁面收到一次中斷完成，`agy acp` 行程已結束
- [ ] 6.6 逾時：以縮短的逾時設定（環境變數）驗證自動拒絕、卡片消失
- [ ] 6.7 續接既有 Antigravity 會話送出新訊息：舊訊息不重複出現；重新整理後歷史完整、沒有系統訊息
- [ ] 6.8 `acceptEdits` 模式修改檔案不需審批、執行指令仍需審批；已同意時 `bypassPermissions` 不出現審批卡片
- [ ] 6.9 迴歸：Codex 審批（允許、拒絕各一次）卡片與結果與改動前相同；Claude 審批照常
- [ ] 6.10 `npm run typecheck`、`npm run lint`（0 錯誤）、相關測試、`npm run build` 全部通過；更新 `server/SERVER.md` 與 `server/modules/providers/README.md` 中 Antigravity 執行層的說明
