## Why

多 Agent 聊天頁的 bug 大多出自同一個根源：系統以 Claude 的工具名作為全系統的中間語言，各 provider 自行把事件偽裝成 `Bash`、`Edit`、`FileChanges` 等名稱，再由前端按名稱查表渲染。目前已經有實際 bug：Codex 在對話中送出的 `FileChanges`、`TodoList`、`WebSearch` 在前端 `toolConfigs.ts` 沒有對應設定，會掉到 `Default` 的原始 JSON 視圖；重新載入歷史時，同一次修改又被 `codex-sessions.provider.ts` 映射成 `Edit`，所以對話中和重新載入後的渲染不一致。

Antigravity 的情況更糟：它直接透傳 CLI 的原始工具名（`antigravity-cli.js:152`），工具結果一律標為成功，所以它的工具多數會掉到原始 JSON 視圖。

存量會話受影響最大。歷史訊息每次都從原始 JSONL 即時解析，本機統計顯示：Codex 1390 次工具呼叫中有 77% 顯示成原始 JSON，主因是新版指令工具 `exec_command` 沒被映射（佔 889 次）；Claude 有 4.1%，其中子 agent 工具已改名為 `Agent`，前端只認舊名 `Task`。

同時，已被 Antigravity CLI 取代的 Gemini CLI 仍佔據前端 37 個、後端 45 個檔案。provider 清單在三層寫死：
- **資料層**：`ProjectListItem` 有五個 `xxxSessions` 欄位，全文檢索寫死 `['claude','codex','gemini']`，導致 antigravity 與 cursor 的歷史搜不到。
- **執行層**：每家各自匯出名稱不同的 query、abort、isActive、reconnect 函式。`server/index.js` 逐一匯入 25 個這類函式；`chat-websocket.service.ts` 為每家各開一種 `xxx-command` 訊息，abort、狀態查詢也各寫一個分支；`routes/agent.js` 又重複一次。
- **前端**：輸入區按 provider 分支組裝送出參數（`useChatComposerState.ts` 有 23 處 provider 字面量）。

所以每次新增或刪除 provider 都要散彈式修改。Codex app-server 已提供執行中插話（`turn/steer`）等能力，但介接層是手寫協議、沒有型別保護，協議改版時要到執行期才會出錯。

這幾個問題在檔案層面互相重疊（同一批 provider、檔案與型別），一次規劃可以避免同一批檔案改兩次。

## What Changes

**階段一：工具渲染一致性**
- Codex 對話中（app-server `ThreadItem`）與歷史載入（rollout JSONL）改走同一套映射，同一個操作在兩條路徑渲染結果一致。
- 補齊 Codex 目前會掉到原始 JSON 的項目：歷史中的指令類工具（`exec_command`、`write_stdin`、`js`）、多檔案修改（含新增、刪除、改名）、計畫/待辦、網頁搜尋、推理內容、上下文壓縮；映射相容 Codex 0.143 以來的 rollout 格式。
- 補齊 Claude 的渲染缺口：`Agent` 與 `Task` 一樣以子 agent 容器渲染，常用工具（`Monitor`、`Skill`、`WebFetch` 等）補上專用設定。
- 新增存量渲染驗收腳本：完成時，本機存量會話中未覆蓋的工具呼叫比例 Codex 從 77% 降到 5% 以下，Claude 從 4.1% 降到 1% 以下。
- 未知或新出現的工具改為通用摘要卡片（標題、狀態、可展開的原始內容），不再直接顯示原始 JSON 視圖。
- Antigravity 新增後端映射：先用真實 transcript 收集工具名，把可辨識的指令、讀檔、改檔、搜尋工具映射成既有渲染形狀，並讓即時與歷史共用同一套映射、正確傳遞工具錯誤。
- 寫明兩層規則：對話流內只允許後端映射後的標準形狀，不在前端寫 provider 判斷；provider 專屬能力放在對話流外（輸入區、側邊面板），由能力表控制顯示。

**階段二：下線 Gemini 並解除 provider 清單寫死**
- **BREAKING** 移除 `gemini` provider：後端介接層、路由、provider facets、前端設定與 gemini 專用工具映射；保留 Antigravity 共用的 `~/.gemini/antigravity*` 路徑。
- **BREAKING** `ProjectListItem` 改為按 provider id 分組的單一結構，取代五個寫死欄位。
- 會話同步改為每個 provider 獨立的掃描游標，單一 provider 失敗不再阻擋其他 provider 前進。
- 全文檢索改由各 provider facet 提供可搜尋內容，補上 antigravity，並在可行時補上 cursor。
- 會話 watcher 的輪詢改為可透過環境變數設定，預設維持現狀。
- `IProvider` 新增 `runtime` 介面（啟動、中斷、是否執行中、列出執行中會話、重新接上），各家用薄轉接包住現有函式。`server/index.js`、`chat-websocket.service.ts`、`routes/agent.js` 改為依 registry 分派。
- **BREAKING** 各家的 `xxx-command` WebSocket 訊息收斂為單一 `chat-command { provider }`；中斷、狀態查詢、執行中會話列表也改為依 registry 處理，每次中斷只產生一個結束事件。
- 新增共用的 provider 資訊表（能力、權限模式），前端輸入區的送出、中斷、狀態查詢改走單一路徑，依資訊表組裝參數。

**階段三：Codex 協議型別化、執行中插話、Session Artifacts 側邊欄與統一審批收件匣**
- 以 `codex app-server generate-ts` 生成的協議型別取代手寫結構，協議漂移在型別檢查期被發現。
- 接上 `turn/steer`：Codex 執行中，使用者可在不中斷的情況下追加指令。插話走 runtime 介面的可選方法，資訊表的 `midTurnSteer` 決定前端是否開放。**前提**：先實測確認插話內容會寫入 rollout，否則重新載入後插話會消失，此時不開放。
- 實作 Session Artifacts 側邊欄：由 provider 的 sessions facet 提供會話產物讀取，API 為 `GET /api/providers/sessions/:sessionId/artifacts`（含路徑穿越防護），前端依資訊表的 `capabilities.artifacts` 在對話流外右側抽屜展示。**前提**：先實測確認 Antigravity CLI 確實在 `brain/<sessionId>/` 寫出 `.md` 產物（目前 repo 中沒有任何證據），否則整組不實作。
- 實作統一權限審批收件匣：補齊 Claude 審批的 `userId` 擁有者驗證（嚴格比對，與 Codex 對齊）；Claude 審批預設逾時從 55 秒放寬到 600 秒，網頁版與桌面版一致；透過 `IProviderRuntime.getPendingApprovals` 匯總跨 provider、跨會話的待審批項目；背景會話的事件不再改變目前畫面的執行狀態；前端跨會話保留待審批池，聊天框內只渲染當前會話的審批卡，側邊欄會話列表顯示「待審批」徽章並提供收件匣快速跳轉與批準。

**非本次範圍（需先做產品決定）**
- Claude 聊天/終端嚴格互斥：目前「允許終端查看同一會話」是刻意設計，要不要改由產品決定，本變更不更動。
- Codex app-server 跨輪保活：會延長所有權鎖的持有時間，與現有交接機制有衝突；`turn/steer` 不依賴保活。
- 終端啟動參數（`shell-websocket.service.ts` 的 provider 分支）、各家登入流程與設定頁：這些是各家真正不同的地方，保留各自實作。
- ACP 接入、多 Agent 平行對比、跨工具規則同步。

## Capabilities

### New Capabilities
- `tool-call-rendering`: 工具呼叫從各 provider 到聊天 UI 的渲染契約，包括即時與歷史一致、Codex（含多版本歷史）、Antigravity 與 Claude 的映射範圍、未知工具的降級方式、存量渲染驗收門檻，以及對話流內外的分層規則。
- `provider-runtime-registry`: provider 執行層的統一介面與分派，包括單一聊天指令訊息、中斷與狀態查詢語義，以及前端的單一送出路徑。
- `provider-session-indexing`: provider 無關的會話索引與專案清單結構，包括按 provider 分組、各自獨立的掃描游標，以及 watcher 輪詢設定。
- `session-conversation-search`: 跨 provider 全文檢索的涵蓋範圍，以及搜尋內容的提取職責歸屬。
- `codex-turn-steering`: Codex 執行中插話的行為、前置條件與失敗處理，以及協議型別的來源。
- `provider-capabilities`: provider 資訊表（能力、權限模式），以及前端依資訊表決定功能顯示與參數組裝的規則。
- `session-artifacts`: 會話產物（Session Artifacts）的 provider 讀取介面、API 與對話流外右側抽屜呈現。
- `unified-approval-inbox`: Claude 審批擁有者綁定與逾時、跨 provider/跨會話待審批查詢、背景會話事件隔離、前端全域待審批池與側邊欄待審批徽章/收件匣。

### Modified Capabilities
- `gemini-app-level-permissions`: 移除全部需求（Gemini provider 下線）。
- `gemini-cli-session-cleanup`: 移除全部需求（Gemini provider 下線）。
- `gemini-tool-name-mapping`: 移除全部需求（Gemini provider 下線）。

## Impact

- **後端**：`server/shared/interfaces.ts`（`IProvider` 新增 `runtime`、`IProviderSessions` 新增搜尋與 artifacts 方法）、`server/claude-sdk.js`、`server/cursor-cli.js`、`server/antigravity-cli.js`、`server/openai-codex.js`（轉 `.ts`）、`server/modules/codex-runtime/`、`server/modules/providers/`（registry、各 provider facets、`session-synchronizer.service.ts`、`sessions-watcher.service.ts`、`session-conversations-search.service.ts`）、`server/modules/projects/`、`server/modules/database/repositories/scan-state.db.ts`、`server/modules/websocket/services/chat-websocket.service.ts`、`server/index.js`、`server/routes/`；刪除 `server/gemini-cli.js`、`server/gemini-response-handler.js`、`server/sessionManager.js`、`server/routes/gemini.js`、`server/modules/providers/list/gemini/`。
- **前端**：`src/components/chat/tools/`（`ToolRenderer.tsx`、`configs/toolConfigs.ts`）、聊天輸入區（`useChatComposerState.ts`、`useChatProviderState.ts`）、右側 Artifacts 側邊面板、`PermissionRequestsBanner`、側邊欄與專案清單的消費端（含待審批徽章与收件匣）、provider 選擇與設定頁、i18n 文案。
- **WebSocket 協議**：`xxx-command`、`cursor-abort`、`cursor-resume` 由 `chat-command` / `abort-session` 取代；`get-pending-permissions` 支援跨 provider 與跨會話查詢；前後端同版發佈。
- **行為變更**：Claude 審批預設逾時由 55 秒改為 600 秒（網頁版、容器部署受影響；桌面版原本即為 600 秒）；`electron/main.js` 移除重複的預設值。
- **共享**：`shared/providers.ts` 新增 provider 資訊表；`LLMProvider` 型別移除 `gemini`。
- **資料**：SQLite 中既有 `provider='gemini'` 的會話紀錄需要處理（見 design）。
- **前置變更狀態**：`unify-codex-runtime-and-approvals`、`stabilize-codex-app-server-runtime` 的核心執行時程式碼已合入 `main` 分支，本變更不重新定義其中的 `codex-runtime` / `codex-session-handoff` 需求，可直接基於現有 `openai-codex.js` 與 `codex-runtime/` 進行。
- **依賴**：不新增 npm 依賴；協議型別生成依賴本機 `codex` CLI，生成結果需提交進版控。
