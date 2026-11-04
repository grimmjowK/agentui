## 1. 階段一：Codex 與 Antigravity 映射模組

- [x] 1.0 新增 `scripts/tool-coverage-report.mjs`（design D1b），在改動前對本機存量會話執行一次並把基準（目前 Codex 77%、Claude 4.1%）記入 design
- [x] 1.1 新增 `server/modules/providers/list/codex/codex-item-mapper.ts`，定義檔案變更的中間形狀（`path`、`kind: add|update|delete`、`movePath`、`diff`）與從 unified diff 拆出 old/new 字串的函式
- [x] 1.2 實作 `mapThreadItem(item, phase)`，涵蓋 `commandExecution`、`fileChange`（逐檔拆分，每則訊息的 `id` 與 `toolId` 均設為 `${itemId}:${index}`，避免 `appendRealtime` 按 `id` 覆蓋）、`mcpToolCall`、`plan`、`webSearch`、`reasoning`、`contextCompaction`，其他類型以原始 `type` 作為 `toolName` 輸出
- [x] 1.3 實作 `mapRolloutEntry(entry, callIdToSplitIdsMap)`：`apply_patch` 解析改為支援 Add/Update/Delete/Move 多段，並將後續 `custom_tool_call_output` 按拆分出的 `${call_id}:${index}` 展開為對應數量的 `tool_result`；`update_plan`（`plan` 與 `steps` 兩種參數）轉為 `TodoWrite` 形狀，`web_search` 轉為 `WebSearch`
- [x] 1.3a 歷史指令類工具映射：`exec_command`/`shell_command`/`exec` → `Bash`（取 `cmd` 或 `command`，`workdir` 為次要文字）；`write_stdin` → `TerminalInput`（無 `chars` 時標示等待輸出）；`js` → `CodeRun`（標題取 `title`）
- [x] 1.4 為 Codex mapper 新增 `codex-item-mapper.test.ts`：從本機真實 rollout 去識別化取得 0.143（`exec`）與 0.163（`exec_command`）兩版 fixture，驗證兩條路徑輸出相同、多檔案 `id`/`toolResult` 配對、改名、`exec_command`/`write_stdin`/`js` 映射
- [x] 1.5 用 Antigravity CLI 跑一個涵蓋執行指令、讀檔、改檔、搜尋、待辦的多步驟任務，收集 `stream-json` 的 `step_update` 與 `transcript.jsonl` 中的工具名、參數形狀、錯誤欄位，去識別化後存成 `docs/fixtures/antigravity/`；同一次執行記錄 `brain/<id>/` 頂層是否有 `.md` 產物及清單，結論寫進 design.md 的 Open Questions（決定第 9 組是否實作）
- [x] 1.6 依 fixture 新增 `server/modules/providers/list/antigravity/antigravity-tool-mapper.ts`：可辨識的工具映射到 `Bash`/`Read`/`Write`/`Edit`/`Grep`/`Glob`/`TodoWrite`，其餘保留原名；依錯誤欄位設定 `isError`（沒有可辨識的欄位就在模組中註明限制）；即時與歷史使用同一種 `toolId` 格式
- [x] 1.7 為 Antigravity mapper 新增測試，以 fixture 驗證即時與歷史輸出相同、`run_command` 映射為 `Bash`、未登記的工具保留原名

## 2. 階段一：接上 mapper 與前端渲染

- [x] 2.1 `server/openai-codex.js` 的 `item/started` / `item/completed` 處理改呼叫 `mapThreadItem`，並處理 `turn/plan/updated` 通知；審批流程仍以原始 `itemId` 為鍵，確認 `approvals.test.ts` 通過
- [x] 2.2 `codex-sessions.provider.ts` 的歷史解析改呼叫 `mapRolloutEntry`，刪除 `normalizeMessage` 中已不會被呼叫到的 `raw.type === 'item'` 分支，確認 `codex-sessions.provider.test.ts` 通過
- [x] 2.3 `antigravity-cli.js` 的 `step_update` 工具處理與 `antigravity-sessions.provider.ts` 的歷史解析改呼叫 Antigravity mapper，確認 `antigravity-sessions.provider.test.ts` 與 `antigravity-cli.integration.test.ts` 通過
- [x] 2.4 `toolConfigs.ts` 新增 `WebSearch`、`TerminalInput`、`CodeRun` 設定，`Edit` / `Write` 的標題支援 `changeKind`（刪除、改名顯示原路徑與新路徑）
- [x] 2.5 `TOOL_CONFIGS.Default` 改為通用摘要卡片（次要文字取 `title`/`command`/`query`/`path`/`server`，原始輸入預設收合，輸入非物件時不報錯），補上 i18n 文案
- [x] 2.6 移除渲染層的 provider 判斷：`MessageComponent.tsx:231` 的助手標籤改為依 provider id 取 i18n 鍵（目前漏了 antigravity），並確認 `src/components/chat/tools/` 內沒有 `provider ===`
- [x] 2.7 在 `src/components/chat/tools/README.md` 寫入 D14 的分層規則；評估 ESLint `no-restricted-syntax` 能否限制 `tools/` 目錄中的 `provider ===`，能就加上
- [x] 2.8 在本機以真實 Codex 與 Antigravity 會話手動驗證：多檔案修改、計畫、搜尋、推理、指令執行在對話中與重新載入後顯示一致，且常見工具沒有原始 JSON 視圖
- [x] 2.9 Claude 子 agent：`useChatMessages.ts:85`、`ToolRenderer.tsx:44`、`SubagentContainer.tsx:33` 把 `Agent` 與 `Task` 一視同仁；用新版 Claude 會話確認子 agent transcript 仍為同目錄的 `agent-<id>.jsonl`，若已改變則一併調整 `claude-sessions.provider.ts` 的讀取
- [x] 2.10 為 Claude 未覆蓋的常用工具新增單行設定：`Monitor`、`Skill`、`TaskStop`、`ScheduleWakeup`、`ToolSearch`、`WebFetch`、`SendMessage`（標題 + 一個關鍵參數）
- [x] 2.11 重新執行 `scripts/tool-coverage-report.mjs`，確認 Codex 低於 5%、Claude 低於 1%，且沒有任何工具從有覆蓋變成沒覆蓋；結果記入 design

## 3. 階段二：Gemini 下線

- [x] 3.1 以任務 1.5 的 fixture 確認 Antigravity 是否用到與 gemini 專用工具設定（`run_shell_command`、`read_file`、`write_file`、`replace` 等）同名的工具，把結論記在 design.md 的 Open Questions
- [x] 3.2 刪除 `server/gemini-cli.js`、`server/gemini-response-handler.js`、`server/sessionManager.js`、`server/routes/gemini.js`、`server/modules/providers/list/gemini/`，並移除 `server/index.js`、`routes/agent.js`、`provider.routes.ts`、`provider-auth.service.ts`、`chat-websocket.service.ts` 中的引用
- [x] 3.3 `LLMProvider` 型別移除 `'gemini'`，以 `npm run typecheck` 修正所有連帶錯誤（前後端）
- [x] 3.4 移除前端 gemini 專用的工具設定、`getToolCategory` 中的 gemini 工具名、provider 選擇與設定頁的 gemini 項目，以及對應 i18n 鍵；3.1 確認為 Antigravity 也在用的工具名則保留
- [x] 3.5 watcher 移除 `~/.gemini/tmp`，保留 `~/.gemini/antigravity-cli/brain`、`~/.gemini/antigravity/brain` 與 `ANTIGRAVITY_HOME`
- [x] 3.6 新增啟動遷移：刪除 `sessions` 表中 `provider='gemini'` 的索引列（不動磁碟檔案）；讀取到未註冊 provider 的資料時略過並記錄 warn，並以收藏紀錄殘留 gemini 的情境測試
- [x] 3.7 刪除 `docs/gemini-cli-protocol.md` 與只服務 gemini 的測試與 fixtures，確認 `antigravity-cli.integration.test.ts` 通過

## 4. 階段二：執行層納入 provider 介面

- [x] 4.1 `server/shared/interfaces.ts` 新增 `IProviderRuntime`（`start`、`abort` 回傳 `{ ok, emitsTerminal }`、`isActive`、`reconnect`、`listActive`、可選的 `steer`、可選的 `getPendingApprovals`），`IProvider` 加上 `runtime`
- [x] 4.2 在 claude、cursor、codex、antigravity 的目錄各新增 `<id>-runtime.provider.ts`，包住 `server/` 根目錄的現有函式，不改寫內部邏輯；差異在轉接層吸收（Claude 的 `reconnectSessionWriter` 取原始 ws、Codex 先 reconnect 再 abort、`emitsTerminal` 依 design D11 的表）
- [x] 4.3 `chat-websocket.service.ts` 新增 `chat-command` 分派並刪除各 `xxx-command`、`cursor-resume`、`cursor-abort` 分支；`abort-session`、`check-session-status`、`get-active-sessions`、`get-pending-permissions` 改為依 registry 處理；`ChatWebSocketDependencies` 只保留 registry 與審批回應相關函式
- [x] 4.4 為分派層新增測試：未註冊的 provider 回傳錯誤、`emitsTerminal` 為 `true` 時不補送結束事件、為 `false` 時補送一次、`get-active-sessions` 的鍵等於已註冊 provider
- [x] 4.5 `server/index.js` 移除逐一匯入的執行函式，`routes/agent.js` 改為透過 registry 啟動
- [x] 4.6 新增 `shared/providers.ts`（provider 資訊表：`capabilities.midTurnSteer/images/effort/artifacts`、`permissionModes`、`defaultPermissionMode`、`mapPermissionMode`），值與目前前端行為一致
- [x] 4.7 前端 `useChatProviderState.ts` 的權限模式預設值改讀資訊表；`useChatComposerState.ts` 的送出改為單一 `chat-command` 路徑，各家模型狀態收斂為 `modelByProvider`，參數依資訊表組裝；中斷與 `ChatInterface.tsx`、`useChatSessionState.ts` 的狀態查詢一併確認走統一訊息
- [x] 4.8 grep 確認前端沒有殘留 `-command'` 訊息類型，並在本機對四個 provider 各跑一輪：送出、中斷、重新整理後狀態恢復、Cursor 續接

## 5. 階段二：資料層解耦

- [ ] 5.1 `scanStateDb` 改為以 provider id 存取 `app_config` 的 `scan_cursor:<providerId>`，並在首次啟動時以全域值（antigravity 取原值）初始化
- [ ] 5.2 `session-synchronizer.service.ts` 改為每個 provider 獨立判斷成敗、獨立推進游標，移除 antigravity 特判與寫死的 `processedByProvider` 初始值；新增「一個 provider 失敗」的測試
- [ ] 5.3 `ProjectListItem` 改為 `sessionsByProvider`，`projects-with-sessions-fetch.service.ts`、`project-management.service.ts` 改為依 registry 組裝
- [ ] 5.4 前端新增 `getProjectSessions(project, provider?)` helper，替換 `useProjectsState.ts`、`useSessionsSource.ts`、`sidebar/utils/utils.ts`、`src/types/app.ts` 等所有舊欄位讀取，並更新 `utils.test.ts`
- [ ] 5.5 `sessions-watcher.service.ts` 讀取 `SESSIONS_WATCHER_POLLING`（預設 `true`）與 `SESSIONS_WATCHER_INTERVAL_MS`（預設 `6000`），並把兩個變數補進 `.env.example`

## 6. 階段二：全文檢索

- [ ] 6.1 `IProviderSessions` 新增可選的 `extractSearchableMessages(filePath)`；先在改動前錄下一組 Claude/Codex 的搜尋基準結果
- [ ] 6.2 把 `session-conversations-search.service.ts` 中 Claude、Codex 的提取邏輯搬進各自的 facet，搜尋範圍改為依實作動態決定，並以 6.1 的基準確認結果不變
- [ ] 6.3 實作 Antigravity 的 `extractSearchableMessages`（讀 `transcript.jsonl`），新增測試
- [ ] 6.4 用真實資料確認 cursor 的 `~/.cursor/projects/**.jsonl` 是否含訊息文字：有則實作提取方法，無則把結論記入 design.md
- [ ] 6.5 搜尋回應新增 `unsearchableProviders`，前端搜尋結果區顯示提示並補 i18n

## 7. 階段三：Codex 協議型別

- [ ] 7.1 新增 `npm run codex:gen-types`，生成到 `server/modules/codex-runtime/protocol/`，只保留介接層實際用到的型別及其相依型別，檔頭寫入 codex 版本，提交生成結果
- [ ] 7.2 `codex-runtime/app-server.ts` 的 `request()` 與通知事件改用生成的 `ClientRequest` / `ServerNotification` 型別
- [ ] 7.3 `server/openai-codex.js` 轉為 `.ts` 並使用生成的型別，`codex-item-mapper.ts` 的輸入改用生成的 `ThreadItem`；`npm run typecheck` 與 Codex 相關測試通過

## 8. 階段三：執行中插話

- [ ] 8.0 用真實 Codex 插話一次，檢查 rollout 是否寫入插話內容、條目形狀與時間位置，結論記入 design.md；未寫入則 8.1–8.5 不實作、`midTurnSteer` 維持 `false`
- [ ] 8.1 Codex runtime 轉接實作 `steer(sessionId, userId, text)`：依 spec 檢查前置條件後呼叫 `turn/steer`（帶 `expectedTurnId`），失敗時回傳 `{ ok: false, reason }`，不中止這一輪；歷史映射把 rollout 中的插話條目還原為使用者訊息；資訊表中 codex 的 `midTurnSteer` 設為 `true`
- [ ] 8.2 `chat-websocket.service.ts` 新增 `chat-steer { provider, sessionId, text }`，分派到 `runtime.steer`；provider 未實作或回傳失敗時送出 `steer-rejected`
- [ ] 8.3 為插話的前置條件與失敗處理新增測試：turn 尚未開始、其他使用者、已按中斷、provider 未實作、app-server 回傳錯誤時這一輪繼續執行
- [ ] 8.4 前端輸入區依資訊表在執行中保持可送出並改走 `chat-steer`，插話成功時在對話流加入使用者訊息，被拒絕時保留輸入並顯示提示，補 i18n
- [ ] 8.5 在本機以真實 Codex 驗證：執行中插話被採納且這一輪未中斷、重新整理後插話仍在原位置；Claude 執行中送出按鈕仍為停用

## 9. 階段三：Session Artifacts 側邊欄（對話流外能力 #13，僅在任務 1.5 確認有產物時實作）

- [ ] 9.1 `IProviderSessions` 新增可選的 `listArtifacts(sessionId)`；Antigravity 的 sessions facet 只讀取 `brain/<sessionId>/` 頂層、實測確認的 `.md` 產物（排除 `.system_generated`），以 `parseSessionId` 驗證 `sessionId`、以 `realpath` 確認不越出 brain 根目錄；新增單元測試，包含路徑穿越與符號連結指向外部兩個情境
- [ ] 9.2 在 `provider.routes.ts` 新增 `GET /api/providers/sessions/:sessionId/artifacts`，provider 從會話索引查得，呼叫 `sessions.listArtifacts(sessionId)`，未實作的 provider 回傳 `[]`
- [ ] 9.3 `PROVIDER_INFO.antigravity.capabilities.artifacts` 設為 `true`；前端在聊天頁工具列依 `capabilities.artifacts` 顯示「產物（Artifacts）」切換按鈕與數量徽章，右側新增可收合 Artifacts 預覽面板（支援切換各 `.md` 產物分頁，並於目前會話 `complete` 時自動刷新），補 i18n

## 10. 階段三：統一權限審批收件匣（#2）

- [ ] 10.1 `server/claude-sdk.js` 的 `waitForToolApproval` 記錄 `userId`，`resolveToolApproval(requestId, userId, payload)` 採嚴格比對（呼叫者缺少 `userId` 或不一致即拒絕，與 `codexApprovals.decide` 一致）；`chat-websocket.service.ts` 被拒時回覆警告；新增「其他使用者越權」與「呼叫者缺少 userId」兩個測試
- [ ] 10.1a `TOOL_APPROVAL_TIMEOUT_MS` 預設值改為 600000，移除 `electron/main.js:214` 的 `?? '600000'` 覆寫，在 `.env.example` 補上 `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` 說明；確認逾時時仍送出 `permission_cancelled`
- [ ] 10.2 `codexApprovals` 新增 `listPending(userId, sessionId?)`；Claude 與 Codex 的 `runtime.getPendingApprovals(userId, sessionId?)` 接通查詢，只回傳該使用者的項目；`chat-websocket.service.ts` 的 `get-pending-permissions` 支援帶 `sessionId`（單一會話）與不帶 `sessionId`（跨所有活躍會話匯總）
- [ ] 10.3 `useChatRealtimeHandlers.ts` 的 `permission_request`、`complete`、`error` 處理改為只在事件 `sid` 等於目前選中會話時才改變載入中、可中斷與狀態文字（沿用 `isCurrentSession` 寫法）；背景會話的事件只更新全域待審批池；為「看著 S2 時 S1 請求審批」「看著執行中的 S2 時 S1 結束」寫元件測試
- [ ] 10.4 前端移除 `useChatProviderState.ts` 在切換 provider 或 session 時清空 `pendingPermissionRequests` 的邏輯，改為全域待審批池（於 WebSocket 連線時拉取全量，並在 `complete`/`error`/`permission_cancelled` 時按事件 `sid` 清理）；`PermissionRequestsBanner` 僅過濾渲染當前 `selectedSession?.id` 的項目（需在 10.3 完成後進行）
- [ ] 10.5 側邊欄會話列表依據全域 `pendingPermissionRequests` 在等待審批的會話旁顯示琥珀色「待審批」徽章，並在側邊欄頂部（有待審批項目時）提供「待審批收件匣」快速跳轉入口，補 i18n

## 11. 收尾與文件同步

- [ ] 11.1 每個階段結束時執行 `npm run typecheck`、`npm run lint`、`npm run build` 與相關測試，全部通過才進入下一階段
- [ ] 11.2 更新 `server/SERVER.md`、`server/modules/MODULES.md`、`server/modules/providers/README.md`、`src/components/chat/tools/README.md`，移除 gemini 相關說明，補上 runtime 介面、`chat-command`、兩個 mapper、`sessionsByProvider`、provider 資訊表、搜尋提取方法、Session Artifacts 與統一審批收件匣
