## Context

**工具渲染的現狀**：前端 `src/components/chat/tools/configs/toolConfigs.ts` 用 `TOOL_CONFIGS[toolName] || TOOL_CONFIGS.Default` 決定渲染方式，`ToolRenderer.tsx:38` 的 `getToolCategory()` 也是按工具名查表。Codex 有兩條互不相通的路徑：

| 路徑 | 來源 | 檔案修改 | 計畫 | 搜尋 | 推理 |
|---|---|---|---|---|---|
| 對話中 | app-server `ThreadItem`（`server/openai-codex.js:100-160`） | `FileChanges`（前端無設定，掉到 Default） | 未處理 | 未處理 | 未處理 |
| 重新載入歷史 | rollout JSONL（`codex-sessions.provider.ts:229-336`） | `apply_patch` → `Edit`（只解析第一個 `Update File`） | `update_plan` 原樣透出 | 未處理 | `reasoning` → thinking |

`codex-sessions.provider.ts:491-604` 的 `raw.type === 'item'` 分支是 SDK `exec` 時代的格式。即時路徑在遷移到 app-server 後已由 `openai-codex.js` 的 `send()` 直接呼叫 `createNormalizedMessage`，不再經過這個分支，等於死碼。

codex 0.163.0 的 `ThreadItem` 型別包含：`agentMessage`、`commandExecution`、`fileChange`（`changes: FileUpdateChange[]`，每項含 `path`、`kind: add|delete|update(move_path)`、`diff`）、`mcpToolCall`、`plan`、`reasoning`、`webSearch`、`contextCompaction`、`dynamicToolCall`、`imageView`、`enteredReviewMode` 等。

**Provider 寫死的現狀**：
- `ProjectListItem` 有五個 `xxxSessions` 欄位，前後端共約 80 處引用（主要在 `src/hooks/useProjectsState.ts`）。
- `session-synchronizer.service.ts` 對 antigravity 特判，用 `app_config` 存它的游標；其他 provider 共用 `scan_state` 單一游標，任何一家失敗都會讓全域游標停止前進。
- `session-conversations-search.service.ts:85` 寫死 `['claude','codex','gemini']`，提取邏輯也全寫在這個服務裡。

**Gemini**：已被 Antigravity CLI 取代。Antigravity 的資料同樣放在 `~/.gemini/antigravity-cli/` 與 `~/.gemini/antigravity/` 底下，刪除時必須保留這些路徑。

**執行層的現狀**：`IProvider`（`server/shared/interfaces.ts:21`）只有 mcp、auth、skills、sessions、sessionSynchronizer 五個 facet，沒有執行層。各家的執行函式都放在 `server/` 根目錄，名稱和語義都不一致：

| | 啟動 | 中斷 | 中斷後誰送出結束事件 | 狀態查詢時重新接上 |
|---|---|---|---|---|
| claude | `queryClaudeSDK` | `abortClaudeSDKSession`（async） | WS 層 | `reconnectSessionWriter(sessionId, rawWs)` |
| cursor | `spawnCursor` | `abortCursorSession`；另有 `cursor-abort` 訊息 | WS 層 | 不支援 |
| codex | `queryCodex` | 先 `reconnectCodexSession` 再 `abortCodexSession` | runtime 自己 | `reconnectCodexSession(sessionId, writer)` |
| antigravity | `spawnAntigravity` | `abortAntigravitySession` | runtime 自己 | `reconnectAntigravitySession(sessionId, writer)` |

`chat-websocket.service.ts` 的 `ChatWebSocketDependencies` 把這些函式逐一列出，`abort-session`、`check-session-status`、`get-active-sessions` 各有一串 provider 分支；`routes/agent.js:946-990` 又重複一次。前端 `useChatComposerState.ts:746-830` 按 provider 分支組裝 `xxx-command` 訊息，各家的 options 欄位大致相同，差別只在模型、權限模式映射、effort、圖片。

**Antigravity 的渲染現狀**：即時路徑（`antigravity-cli.js:150-175`）直接透傳 `step.tool_name`，工具結果固定 `isError: false`，`toolId` 是 `agy_tool_${step_index}`；歷史路徑（`antigravity-sessions.provider.ts:161`）另外產生 `toolName`。目前程式碼和測試裡只出現過 `run_command` 一個真實工具名，本機也沒有可用的 transcript，所以真實工具名清單需要先收集。

**協議**：`codex app-server generate-ts` 可生成完整協議型別（已用 0.163.0 確認，含 `TurnSteerParams { threadId, input, expectedTurnId }` → `{ turnId }`）。

**前置相關變更狀態**：`unify-codex-runtime-and-approvals`、`stabilize-codex-app-server-runtime` 的核心執行時程式碼已合入 `main` 分支（`openai-codex.js` 與 `codex-runtime/` 已就緒）。

## Goals / Non-Goals

**Goals:**
- Codex 和 Antigravity 同一個操作在對話中與重新載入後渲染一致，且常見工具不再出現原始 JSON 視圖。
- 新增一個 provider 時，後端只需新增 `providers/list/<id>/`（含 runtime 轉接）並在 registry 註冊；前端只需在 provider 資訊表加一列，再加上它真正專屬的 UI（登入、設定）。
- antigravity 的歷史可以被全文檢索，且其會話產物（`brain/<sessionId>/` 下的 `task.md`、`implementation_plan.md`、`walkthrough.md` 等）可在對話流外右側 Artifacts 側邊欄檢視。
- 跨 provider（Claude、Codex）、跨會話的待審批權限請求可在側邊欄徽章與統一審批收件匣中查看並處理，切換會話不再遺失背景會話的待審批狀態，且 Claude 審批具備與 Codex 一致的 `userId` 擁有者驗證。
- Codex 執行中可以追加指令，不必中斷。
- 協議改版造成的欄位漂移在 `npm run typecheck` 階段就會被發現。

**Non-Goals:**
- 不把所有 provider 改成一套全新的語義原語 IR（`uiBlocks`）。以 Claude 的工具形狀為標準形狀，其他 provider 在後端映射過去；Claude 的渲染不變。
- 不改 Claude 的聊天/終端並存行為（`shell-websocket.service.ts:57-63` 記載的刻意設計）。
- 不把終端啟動（`shell-websocket.service.ts` 的 provider 分支）、登入流程、設定頁納入統一介面；這些是各家真正不同的地方。
- 不做 Codex app-server 跨輪保活，也不做 `thread/fork`、`thread/rollback`、`review/start`。
- 不重新定義 `codex-runtime`、`codex-session-handoff`、`codex-interactive-approvals` 的需求。

## Decisions

### D1. Codex 映射集中到一個模組，即時與歷史共用

新增 `server/modules/providers/list/codex/codex-item-mapper.ts`，對外提供兩個函式：
- `mapThreadItem(item: ThreadItem, phase: 'started' | 'completed')`：給 `openai-codex.js` 的 notification handler 使用。
- `mapRolloutEntry(entry, callIdToSplitIdsMap)`：給 `codex-sessions.provider.ts` 的歷史解析使用。

兩者輸出同一組 `NormalizedMessage`。映射目標**沿用前端既有的渲染器形狀**：
- 檔案修改：每個檔案各輸出一則 `tool_use`。新增檔案對應 `Write`（`file_path`、`content`），更新對應 `Edit`（`file_path`、`old_string`、`new_string`），刪除和改名另外帶 `changeKind` 欄位給標題顯示。
  - **即時流 ID 對齊**：前端 `useSessionStore.appendRealtime` 以 `NormalizedMessage.id` 合併 `item/started` 與 `item/completed`，因此拆分出的每則訊息其 `id` 與 `toolId` 均須設為 `${itemId}:${index}`，避免多檔案在同一輪互相覆蓋。
  - **歷史流 `tool_result` 配對**：rollout JSONL 中 `custom_tool_call`（`apply_patch`）與 `custom_tool_call_output` 為前後獨立紀錄、靠 `call_id` 關聯。當一個 `apply_patch` 拆為 `${call_id}:0` .. `${call_id}:${n-1}` 時，後續對應的 `custom_tool_call_output` 必須展開為對應數量的 `tool_result`（`toolId` 分別為 `${call_id}:${index}`），確保前端能將結果掛回每一筆拆分後的 `Write` / `Edit`。
- 計畫：`plan` item、`turn/plan/updated` 通知、歷史的 `update_plan`，全部轉成 `TodoWrite` 形狀（`todos: [{ content, status }]`）。歷史的 `update_plan` 參數有 `plan` 與 `steps` 兩種形式（本機存量 6 筆與 2 筆），兩種都要支援。
- 指令類工具（歷史）：本機存量 Codex 會話中，`exec_command` 佔全部工具呼叫的 64%（889/1390），但目前的歷史解析只認 `shell_command` 與 `exec`（`codex-sessions.provider.ts:233`），這是存量會話顯示原始 JSON 的最大來源。映射規則：
  - `exec_command`、`shell_command`、`exec` → `Bash`，指令取 `cmd` 或 `command`，`workdir` 作為次要文字。
  - `write_stdin`（136 次）→ 新增 `TerminalInput` 渲染：有 `chars` 時顯示送出的字元，沒有 `chars` 時標示為等待終端輸出。
  - `js`（31 次）→ 新增 `CodeRun` 渲染：標題取 `title`，`code` 預設收合。
  - 其餘少量工具（`wait`、`view_image`、`attach_artifact` 等，合計 13 次）交給 D2 的降級卡片。
- 網頁搜尋：`webSearch` → `WebSearch`（`query`），前端新增對應設定。
- 推理：`reasoning` → `kind: 'thinking'`。
- 上下文壓縮：`contextCompaction` → `isCompactBoundary: true`，沿用 `fix-chat-sync-and-transcript-coverage` 已有的渲染。
- 其他項目（`dynamicToolCall`、`imageView`、審查模式等）：輸出 `tool_use`，`toolName` 用原始 `type`，交給 D2 的降級卡片處理。

rollout 的 `apply_patch` 解析器改為支援 `*** Add File` / `*** Update File` / `*** Delete File` / `*** Move to` 多段，與即時路徑的 `FileUpdateChange[]` 收斂到同一個中間形狀後再映射。

**為何不直接做全面的語義原語 IR**：那需要改動所有 provider 和整個前端渲染層，風險和回歸面都太大。目前的 bug 集中在 Codex 兩條路徑不一致，先統一映射就能解決；若之後還有第二個 provider 出現同類問題，再升級成全面 IR。

**為何要把 rollout 的 `item` 分支一併刪除**：它是死碼，留著會讓人誤以為那是即時路徑。

**多版本相容**：本機存量 rollout 由 6 個 Codex 版本寫出（0.143.0 至 0.163.0）。測試 fixture 從本機真實會話去識別化後取得，至少涵蓋 0.143（以 `exec` 執行指令）與 0.163（以 `exec_command` 執行指令）兩個版本。

### D1a. Claude 渲染缺口

- **子 agent 工具改名**：Claude Code 已把子 agent 工具從 `Task` 改名為 `Agent`，但前端判斷子 agent 容器只認 `Task`（`useChatMessages.ts:85`、`ToolRenderer.tsx:44`、`SubagentContainer.tsx:33`），所以 `Agent` 呼叫會顯示成原始 JSON。後端附加子 agent 工具是依 `toolUseResult.agentId`（`claude-sessions.provider.ts:163`），與工具名無關，所以只需要在前端把 `Agent` 加入判斷。實作時要確認新版 Claude 的子 agent transcript 仍是 `agent-<id>.jsonl`、仍與主 transcript 放在同一個目錄，否則後端也要一併調整。
- **未覆蓋的常用工具**：本機 100 個 Claude 會話中，沒有專用設定的工具佔 4.1%（570/13801），依次數為 `Monitor` 147、`Skill` 122、`Agent` 65、`TaskStop` 59、`ScheduleWakeup` 55、`ToolSearch` 54、`WebFetch` 20、`WebSearch` 16、`SendMessage` 15。這些工具一律新增單行設定（標題 + 一個關鍵參數），不另外做複雜元件。

### D1b. 存量渲染驗收腳本

新增 `scripts/tool-coverage-report.mjs`：掃描 `~/.claude/projects` 與 `~/.codex/sessions`，套用與後端相同的工具名映射，對照 `toolConfigs.ts` 中的設定，輸出各 provider 未覆蓋的工具名、次數與比例（MCP 工具另計）。變更前的基準為 Codex 77%、Claude 4.1%；完成時的門檻為 Codex 低於 5%、Claude 低於 1%。腳本只讀本機檔案、只輸出統計結果，不輸出任何會話內容。

**為何用腳本而不是單元測試**：存量資料在使用者本機，無法放進 CI；腳本作為驗收工具和回歸檢查，數字直接對應「使用者打開舊會話看到多少原始 JSON」。

### D2. 未知工具改用通用摘要卡片

`TOOL_CONFIGS.Default` 改為 collapsible 卡片：標題取 `toolName`，次要文字優先取 `title` / `command` / `query` / `path` / `server` 中第一個存在的字串，展開後才顯示原始 JSON。不做按 provider 的特判。

### D3. `ProjectListItem` 改為按 provider 分組

```ts
sessionsByProvider: Partial<Record<LLMProvider, SessionSummary[]>>
```

取代五個 `xxxSessions` 欄位；後端依 `providerRegistry.listProviders()` 組裝。前後端在同一個 repo、同一個版本一起發佈，桌面版也會同時打包，所以**一次性替換，不保留相容欄位**。前端新增一個 `getProjectSessions(project, provider?)` helper，集中所有讀取處。

**替代方案**：保留舊欄位並新增新欄位作為過渡。這會讓兩套欄位長期並存，與「消除散彈式修改」的目標相反，因此不採用。

### D4. 每個 provider 獨立的掃描游標

`scanStateDb.getLastScannedAt(providerId)` / `updateLastScannedAt(at, providerId)` 統一存在 `app_config` 的 `scan_cursor:<providerId>` 鍵。遷移時，以現有的全域 `scan_state.last_scanned_at` 作為每個 provider 的初始值，antigravity 沿用它既有的 `antigravity_last_scanned_at`。`synchronizeSessions` 對每個 provider 個別判斷成功與否，個別前進游標，不再有 antigravity 特判。

**為何不改 `scan_state` 表結構**：改成 `app_config` 鍵值不需要做 schema 遷移，antigravity 也已經在用同一個模式。

### D5. 全文檢索的提取下放到 provider facet

在 `IProviderSessions` 新增可選方法：

```ts
extractSearchableMessages?(filePath: string): AsyncIterable<{ sessionId, role, text, timestamp }>
```

搜尋服務保留 ripgrep 預篩檔案與片段高亮的共用邏輯，provider 清單改由「有實作這個方法的 provider」動態決定。先把 claude 和 codex 現有的提取邏輯搬進各自的 facet，再新增 antigravity 的（讀 `transcript.jsonl`）。cursor 在實作時先確認 `~/.cursor/projects/**.jsonl` 是否含有訊息文字：有就實作；沒有就不實作，並由搜尋回應的 `unsearchableProviders` 欄位讓 UI 明確告知。

### D6. Gemini 下線與既有資料

- 刪除介接層、路由、`providers/list/gemini/`、`LLMProvider` 的 `'gemini'`、前端 gemini 專用工具設定（`run_shell_command`、`read_file`、`write_file`、`replace`、`grep_search`、`write_todos`、`invoke_agent`、`list_directory`、`enter_plan_mode`、小寫 `exit_plan_mode`）。刪除前先 grep 確認 Antigravity 沒有產生同名工具；若有，就保留該項並改為歸屬 Antigravity。
- watcher 移除 `~/.gemini/tmp`，保留 `~/.gemini/antigravity*`。
- SQLite：啟動遷移時刪除 `sessions` 表中 `provider='gemini'` 的**索引列**。磁碟上的 Gemini 檔案不動，因為那是使用者資料。
- 讀取到未知 provider 的資料時（例如舊的收藏紀錄），一律略過並記錄 warn，不讓程式崩潰。

### D7. watcher 輪詢可設定

讀取 `SESSIONS_WATCHER_POLLING`（預設 `true`）與 `SESSIONS_WATCHER_INTERVAL_MS`（預設 `6000`）。預設值維持不變，因為部署在 k8s 的 Linux 容器上，改用 inotify 監聽 `depth: 6` 的大目錄有碰到 `max_user_watches` 上限的風險。本機或桌面版可以自行關閉輪詢。

### D8. 協議型別生成並提交進版控

新增 `npm run codex:gen-types`，執行 `codex app-server generate-ts --out server/modules/codex-runtime/protocol/`，生成結果提交進 repo，檔頭標註生成時的 codex 版本。`codex-runtime/app-server.ts` 的 `request()` 和通知處理改用 `ClientRequest` / `ServerNotification` 等泛型。`openai-codex.js` 改為 `.ts`，否則型別無法發揮作用。

**為何提交生成結果，而不是在建置時生成**：CI 和 Docker 建置環境不一定裝有 codex CLI。何時更新型別應該由人決定，並在 code review 時看得到 diff。

**縮小提交範圍**：完整生成約有 747 個檔案、3MB。只提交介接層實際用到的型別及其相依型別（由生成腳本從入口型別往下收集），其餘不進版控，以降低每次升級時 review 的負擔。

### D9. 執行中插話（`turn/steer`）

- **前置驗證**：生成的 `TurnSteerParams` 只有 `threadId`、`input`、`expectedTurnId`，看不出插話內容會不會寫進 rollout。實作前先用真實 Codex 插話一次，檢查 rollout 中是否出現對應的使用者訊息條目、條目形狀與時間位置。
  - 有寫入：歷史解析的映射要能把它還原成使用者訊息，放在正確的時間位置。
  - 沒有寫入：本能力不開放，資訊表中 codex 的 `midTurnSteer` 維持 `false`。否則就會產生新的「對話中看得到、重新載入後消失」的不一致。
- runtime 介面新增可選方法 `steer?(sessionId, userId, text)`，只有 Codex 實作。新增 WebSocket 訊息 `chat-steer { provider, sessionId, text }`，分派到該 provider 的 `runtime.steer`；provider 沒有實作時直接回傳 `steer-rejected`。
- Codex 的實作找到 `activeCodexSessions.get(sessionId)`，確認呼叫者是同一個使用者、run 尚未結束、且 `state.turnId` 已存在後，呼叫 `turn/steer { threadId, input, expectedTurnId: state.turnId }`。
- 任一前置條件不成立，或 RPC 回傳錯誤，只回傳 `steer-rejected` 給前端，**不呼叫 `fail()` 中止整輪**，前端保留使用者輸入的文字。
- 插話內容以 `role: 'user'` 的文字訊息出現在對話流中。
- 不需要保活：插話只發生在執行中，那時 app-server 本來就還活著。

### D10. Provider 資訊表

新增 `shared/providers.ts`：

```ts
export const PROVIDER_INFO: Record<LLMProvider, {
  capabilities: { midTurnSteer: boolean; images: boolean; effort: boolean; artifacts: boolean };
  permissionModes: PermissionMode[];
  defaultPermissionMode: PermissionMode | (() => PermissionMode);
  mapPermissionMode?: (mode: PermissionMode) => PermissionMode; // 例：codex 把 plan 映射為 default
}>
```

型別用 `Record<LLMProvider, …>`，漏加 provider 時 `typecheck` 會報錯。放入本次會用到的能力（插話 `midTurnSteer`、圖片 `images`、推理強度 `effort`、會話產物面板 `artifacts`）與權限模式設定，不預先放 fork、rollback 等尚未實作的能力。名稱、圖示仍由前端 i18n 與資源處理，不放進共用表。

前端 `useChatProviderState.ts` 的權限模式預設值、`useChatComposerState.ts` 的送出參數組裝、以及右側 Artifacts 側邊欄按鈕顯隱，改為讀這張表。各家的模型狀態（`claudeModel`、`codexModel`…）收斂為 `modelByProvider`。

### D11. 執行層納入 `IProvider`

`IProvider` 新增 `readonly runtime: IProviderRuntime`：

```ts
interface IProviderRuntime {
  start(command: string, options: ChatRunOptions, writer: WebSocketWriter): Promise<void>;
  abort(sessionId: string, writer: WebSocketWriter): Promise<{ ok: boolean; emitsTerminal: boolean }>;
  isActive(sessionId: string): boolean;
  reconnect(sessionId: string, writer: WebSocketWriter): boolean; // 不支援重新接上的 provider 只回傳 isActive
  listActive(): unknown[];
  steer?(sessionId: string, userId: unknown, text: string): Promise<{ ok: boolean; reason?: string }>;
  getPendingApprovals?(userId: string | number | null, sessionId?: string): PendingApprovalItem[];
}
```

每家在自己的目錄新增 `<id>-runtime.provider.ts`，包住 `server/` 根目錄的現有函式，**不改寫內部邏輯**。差異在轉接層吸收：
- Claude 的 `reconnectSessionWriter` 需要原始 ws，轉接層從 writer 取用。
- Codex 的中斷要先 `reconnect` 再 `abort`，在轉接層內完成。
- `emitsTerminal` 告訴分派層要不要補送 `complete`：Codex、Antigravity 為 `true`，Claude、Cursor 為 `false`。這樣每次中斷固定只產生一個結束事件。
- `getPendingApprovals` 由支援互動審批的 provider（Claude、Codex）實作，供 D16 統一審批收件匣按 registry 匯總。

**為何不直接把根目錄的檔案搬進模組**：內部邏輯穩定，只是對外介面不一致。轉接層的改動最小，以後要搬再搬。

### D12. 單一聊天指令與分派

- `chat-websocket.service.ts` 的 `xxx-command` 分支合併為 `chat-command { provider, command, options }`，以 `providerRegistry.resolveProvider(provider).runtime.start(...)` 分派；未註冊的 provider 回傳錯誤訊息。`warnOnConcurrentShellSession` 維持現有規則：Codex 以外的 provider 才發警告。
- `abort-session`、`check-session-status`、`get-active-sessions`、`get-pending-permissions` 改為依 registry 處理；`cursor-abort` 併入 `abort-session`。`cursor-resume` 改為 `chat-command` 帶 `options.resume: true` 和空指令。
- `ChatWebSocketDependencies` 只保留 registry 與審批回應函式；`server/index.js` 不再逐一匯入執行函式。
- `routes/agent.js` 同樣改為透過 registry 啟動。
- 前端送出、中斷、狀態查詢改成單一路徑：`sendMessage({ type: 'chat-command', provider, command, options })`，options 依 D10 的資訊表組裝。

**為何不保留舊訊息類型做相容**：前後端在同一個 repo 一起發佈，桌面版也一起打包，沒有舊客戶端需要相容。

### D13. Antigravity 映射

新增 `server/modules/providers/list/antigravity/antigravity-tool-mapper.ts`，即時（`antigravity-cli.js` 的 `step_update`）與歷史（`antigravity-sessions.provider.ts`）共用：
- 先從真實 transcript 收集工具名與參數形狀（任務 1.5），記錄成 fixture。
- 可辨識的工具映射到標準形狀：指令執行 → `Bash`（`command`）、讀檔 → `Read`（`file_path`）、寫檔與改檔 → `Write` / `Edit`、搜尋 → `Grep` / `Glob`、待辦 → `TodoWrite`。目前唯一確認的是 `run_command` → `Bash`。
- 無法辨識的工具保留原名，交給 D2 的降級卡片。
- 工具結果依 `tool_info` 中的錯誤或結束碼欄位設定 `isError`（欄位名稱以 fixture 為準），不再固定為 `false`。
- 即時與歷史的 `toolId` 都使用 `step_index` 推得的同一種格式，讓重新載入後能和即時訊息對上。

### D14. 對話流內外的分層規則

寫進 `src/components/chat/tools/README.md`，作為 review 時的依據：
- **對話流內**（訊息與工具卡片）：只接受後端映射後的標準形狀（Claude 工具形狀、`thinking`、壓縮邊界、通用降級卡片）。`src/components/chat/tools/` 與訊息元件中不得出現 `provider === '<id>'` 判斷。某家出現新的工具或事件，改的是該家的後端映射，不是前端。
- **對話流外**（輸入區按鈕、側邊面板、狀態列）：provider 專屬能力放這裡，是否顯示由 D10 的資訊表決定。
- 新增標準形狀（例如未來的行內卡片）屬於跨 provider 的設計決定，需要在 spec 中定義，不能為單一 provider 加。

### D15. Session Artifacts 側邊欄與 Provider 產物讀取

作為 D14「對話流外能力」的落實，但**以實測為前提**：目前整個 repo 沒有任何地方引用 `task.md`、`implementation_plan.md`、`walkthrough.md`，本機的 brain 目錄也是空的，無法確認 Antigravity CLI 是否會寫出這些檔案（它們可能只是桌面版的功能）。任務 1.5 實測後：
- **有產物**：依下列設計實作，`capabilities.artifacts` 設為 `true`。
- **沒有產物**：整組不實作，`artifacts` 維持 `false`，在 Open Questions 記錄結論，之後另開變更評估讀取桌面版目錄的可行性。

設計：
- 在 `IProviderSessions` 新增可選方法：
  ```ts
  listArtifacts?(sessionId: string): Promise<Array<{ id: string; title: string; fileName: string; updatedAt: string; content: string }>>
  ```
- **Antigravity 實作**：複用 `antigravity-sessions.provider.ts` 現有的 `brain/<sessionId>/` 路徑解析邏輯，只掃描該會話目錄頂層的 `.md` 檔案（以實測清單為準），排除 `.system_generated` 子目錄。
- **路徑安全**：`sessionId` 會被拼進檔案路徑，所以要先用既有的 `parseSessionId` 驗證；每個候選檔案以 `fs.realpath` 解析後，確認仍在該 provider 的 brain 根目錄內，不在範圍內的（包括符號連結指向外部）一律略過；只回傳副檔名為 `.md` 的檔案。
- **HTTP 路由**：新增 `GET /api/providers/sessions/:sessionId/artifacts`，放在 `provider.routes.ts`，與其他以 sessionId 為主的會話路由一致。provider 從會話索引查得，不由前端傳入；未實作 `listArtifacts` 時回傳空陣列 `[]`。
- **前端側邊欄**：當 `PROVIDER_INFO[provider].capabilities.artifacts` 為 `true` 且當前有選中 `sessionId` 時，在聊天頁頂部工具列顯示「產物（Artifacts）」切換按鈕（附帶產物數量徽章），點開後在聊天頁右側展示可收合抽屜，以分頁切換檢視各 `.md` 產物的 Markdown 渲染結果，並在**目前會話**的一輪對話完成（`complete`）時自動刷新。

### D16. 統一權限審批收件匣與 Claude 審批安全綁定

解決目前切換會話時待審批遺失、背景會話卡住無感知、以及 Claude 審批缺少 `userId` 驗證的三個問題：
1. **Claude 審批綁定 `userId`（安全對齊）**：
   - 在 `server/claude-sdk.js` 的 `waitForToolApproval(requestId, options)` 中，將 `writer.userId`、`sessionId`、`toolName`、`input`、`context`、`createdAt` 一併存入 `pendingToolApprovals`。
   - `resolveToolApproval(requestId, userId, payload)` 採用與 `codexApprovals.decide` 相同的嚴格比對：待審批有記錄擁有者時，呼叫者的 `userId` 必須存在且相同；呼叫者缺少 `userId` 或不一致時拒絕並回傳 `false`，`chat-websocket.service.ts` 收到 `false` 時回覆一則 `task_notification` 警告（與 Codex 的處理方式一致）。
   - **逾時放寬到 600 秒**：`TOOL_APPROVAL_TIMEOUT_MS` 的預設值從 55000 改為 600000，網頁版、k8s 部署與桌面版一致；`CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` 有設定時以設定值為準。`electron/main.js:214` 的 `?? '600000'` 覆寫因此變得多餘，予以移除，只保留後端這一個預設值。收件匣主要用來處理背景會話，55 秒內使用者通常還沒看到請求就已經被自動拒絕了，所以放寬逾時是收件匣有用的前提。55 秒是上游專案最初的值，沒有找到記載的理由；桌面版自 commit `85f44055` 起已經用 600 秒運作，可作為佐證。
2. **跨 Provider、跨會話待審批查詢**：
   - `codexApprovals` 新增 `listPending(userId, sessionId?)`，回傳該使用者尚未過期的待審批訊息陣列。
   - Claude 與 Codex 的 `runtime.getPendingApprovals(userId, sessionId?)` 分別封裝各自的查詢。
   - WebSocket 的 `get-pending-permissions` 支援兩種模式：帶 `sessionId` 時回傳該會話（跨 provider）的待審批項目；不帶 `sessionId` 時遍歷 `providerRegistry.listProviders()` 匯總該使用者在所有活躍會話中的待審批項目。
3. **前端全域待審批池與側邊欄收件匣**：
   - 移除 `src/components/chat/hooks/useChatProviderState.ts:146-154` 在切換 `provider` 或 `selectedSession` 時清空/過濾 `pendingPermissionRequests` 的 `useEffect`，讓 `pendingPermissionRequests` 成為跨會話的全域待審批池（僅在收到 `permission_cancelled`、使用者做出決定、或對應 `sid` 收到 `complete` 時移除該 `sid` 的項目）。
   - WebSocket 連線成功時送出一次不帶 `sessionId` 的 `get-pending-permissions`，初始化全量待審批池。
   - 聊天框內的 `PermissionRequestsBanner` 只過濾渲染 `r.sessionId === selectedSession?.id` 的項目。
   - 側邊欄會話列表比對 `pendingPermissionRequests.some(r => r.sessionId === session.id)`，在等待審批的會話旁顯示醒目的琥珀色「待審批」徽章；並在側邊欄頂部（當全域池非空時）顯示「待審批收件匣」摘要列，點擊可直接跳轉至對應會話處理。
4. **背景會話事件不得改變目前畫面**：目前 `useChatRealtimeHandlers.ts` 收到 `permission_request`（:370-385）時會無條件執行 `setIsLoading(true)`、`setCanAbortSession(true)` 與「Waiting for permission」狀態；收到 `complete`（:258-270）時也會無條件 `setIsLoading(false)`。過去切換會話時待審批清單會被清空，所以這個問題沒有浮現；改成全域待審批池後，背景會話的審批請求就會讓使用者正在看的會話卡在等待審批的狀態。修正方式：
   - 以事件的 `sid` 與目前選中的會話比對（沿用同檔 `check-session-status` 處理中已有的 `isCurrentSession` 寫法），只有相同時才改變載入中、可中斷、狀態文字。
   - 背景會話的事件只更新全域待審批池；`complete` 與 `error` 依事件的 `sid` 清理池中的項目。
   - 以「看著 S2 時 S1 請求審批」「看著執行中的 S2 時 S1 結束」兩個情境寫元件測試。

## Risks / Trade-offs

- [`ProjectListItem` 一次性替換，漏改某處讀取會讓清單變空] → 刪除舊欄位後靠 `npm run typecheck` 列出所有錯誤，並為 `getProjectSessions` 和側邊欄 utils 加上測試。
- [每檔案一則 `tool_use` 的 `toolId` 與審批卡片的 `itemId` 對不上] → 審批流程仍以原始 `itemId` 為鍵，D1 的映射只影響渲染；實作時用現有的 `approvals.test.ts` 確認沒有回歸。
- [從 unified diff 拆出 old/new 字串會丟失上下文行] → 與現有歷史路徑的品質相同，屬於已知的上限；之後如果 diff 渲染器支援 unified diff，就直接傳 `diff`。
- [生成的型別會跟著本機 codex 版本漂移] → 檔頭記錄版本；更新時由人執行 `codex:gen-types` 並在 review 檢查 diff。
- [`turn/steer` 在 turn 剛開始時可能回傳「無作用中 turn」，與 `docs/codex-runtime-protocol.md` 記錄的 interrupt 行為相同] → D9 規定在 `turnId` 存在之前不送出 steer，失敗時只回傳拒絕訊息，不影響這一輪。
- [刪除 gemini 時誤刪 Antigravity 共用的 `~/.gemini` 路徑或工具名] → D6 規定刪除前先 grep 確認；Antigravity 的整合測試（`antigravity-cli.integration.test.ts`）必須通過。
- [`chat-command` 一次替換，漏改某個呼叫點會導致該 provider 無法送出] → 刪除舊訊息分支後，用 grep 確認前端沒有殘留 `-command'`；每個 provider 在本機各跑一輪送出、中斷、重新整理後狀態恢復。
- [中斷事件重複或遺漏] → 為分派層加測試：`emitsTerminal` 為 `true` 時不補送、為 `false` 時補送一次。
- [Antigravity 真實工具名與參數形狀未知，映射可能猜錯] → D13 規定先收集 fixture 再寫映射；無法辨識的一律走降級卡片，不猜。
- [分層規則只靠 review，會逐漸被破壞] → README 寫明規則，並在 `tools/` 目錄的 lint 設定中禁止 `provider ===` 的寫法（若 ESLint 的 `no-restricted-syntax` 能直接表達就加上，不能就只靠 review）。
- [全域待審批池在背景會話結束時若漏收事件會殘留過期徽章] → `complete` 與 `error` 事件按事件本身的 `sid`（而非僅當前選中會話）清理 `pendingPermissionRequests` 中 `r.sessionId === sid` 的項目，且 Claude 與 Codex（皆為 600 秒）逾時都會主動發送 `permission_cancelled`。
- [逾時放寬到 600 秒後，未處理的審批會讓 Claude 的一輪對話掛著更久、持有更多資源] → 審批等待期間沒有模型呼叫，只有一個掛起的 promise；使用者仍可隨時中斷。部署時若有疑慮，可用 `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` 調回較短的值。
- [背景會話事件誤改目前畫面狀態] → D16 第 4 點的會話比對，並以兩個情境的元件測試把關。
- [存量 rollout 版本多樣，映射可能改壞舊會話] → D1 多版本 fixture 與 D1b 驗收腳本；變更前後各跑一次腳本，任何工具的覆蓋從有變成沒有都視為回歸。
- [Artifacts 與插話依賴尚未驗證的 CLI 行為] → 兩者都以實測結果作為開關（D9、D15），驗證不通過就不開放，不做猜測性實作。

## Migration Plan

1. **階段一**（Codex 與 Antigravity 渲染一致性、分層規則）可以獨立發佈。回滾方式：還原兩個 mapper 模組與 `toolConfigs.ts`，沒有資料變更。
2. **階段二**（Gemini 下線、資料層與執行層解耦）一次發佈，順序為：先刪 Gemini（少包一家轉接），再做 runtime 介面與 `chat-command`，最後做資料層與搜尋。啟動遷移會刪除 gemini 索引列，並初始化每個 provider 的游標。回滾：還原程式碼後，舊版程式碼重新掃描時會用全域游標補回索引（gemini 的檔案仍在磁碟上）；WebSocket 協議隨前後端一起回滾。
3. **階段三**（型別生成、插話、Session Artifacts 側邊欄、統一審批收件匣）在階段二完成後推進。回滾：把資訊表中 codex 的 `midTurnSteer` 或 antigravity 的 `artifacts` 設為 `false`，前端即可關閉對應入口。

## Implementation Notes（階段一實測）

- **覆蓋率**（`npx tsx scripts/tool-coverage-report.mjs`，腳本直接 import 後端 mapper 與前端 `toolConfigs.ts`）：
  - 改動前（僅換上新 mapper、前端未加設定）：Claude 1130/16297（6.9%，本機存量已比提案時多）、Codex 417/1415（29.5%；提案時舊映射為 77%）。
  - 完成後：Claude 21/16320（0.1%，剩 `GetTask`、`ListAgents`、`SubagentHandback`、`PushNotification`）、Codex 13/1415（0.9%，剩 `wait`、`open_in_codex`、`attach_artifact`、`view_image`、`load_workspace_dependencies`），皆走通用摘要卡片；門檻通過，且沒有工具從有覆蓋變為無覆蓋。
- **Codex `exec` 的真實語義**：0.143 / 0.154 的 `custom_tool_call: exec` 的 input 是 code mode 的 JS（內部再呼叫 `tools.exec_command`），不是 shell 指令，因此映射為 `CodeRun` 而非 `Bash`；`exec_command`/`shell_command` 才映射為 `Bash`。
- **Codex `plan` item** 是自由文字計畫（`{ id, text }`），映射為 `ExitPlanMode` 計畫卡片；步驟清單來自 `turn/plan/updated` 與歷史 `update_plan`，映射為 `TodoWrite`（`inProgress` → `in_progress`）。
- **Claude 子 agent transcript 已搬家**：新版寫在 `<project>/<sessionId>/subagents/agent-<id>.jsonl`（本機 64 個全在此），`claude-sessions.provider.ts` 改為先找新位置、再找舊的同目錄位置。
- **Antigravity 實測（agy 1.5.0，fixture 在 `docs/fixtures/antigravity/`）**：
  - 即時 `step_update` 的工具名：`run_command`、`read_file`、`write_file`、`edit_file`、`search_web`；`tool_info.parameters` 只有摘要欄位（`Path`、`CommandLine`、`query`），**不含檔案內容**，所以即時路徑的 Write/Edit 沒有 diff，重新載入後才完整（已在 mapper 註明為已知限制）。
  - `init.tools` 另列出 `view_file`、`write_to_file`、`replace_file_content`、`grep_search`、`find_by_name`、`list_dir` 等內部名稱，但兩次實測（含明確要求使用這些工具）都沒有出現在 `step_update`，參數形狀未知，不猜測映射，交給通用卡片。
  - 歷史 `transcript.jsonl`：PLANNER_RESPONSE 的 `tool_calls[k]` 對應第 `step_index + 1 + k` 步，`args` 的值被二次 JSON 編碼；結果在後續 GENERIC 步驟。即時與歷史統一使用 `agy_tool_${step_index}`。
  - 錯誤欄位：即時 `state: 'ERROR'` + `tool_info.error.message`；歷史 GENERIC `status: 'ERROR'`；指令以 `Command exited with code N.` 判斷結束碼。`isError` 不再固定為 `false`。
  - 待辦：Antigravity 沒有 todo 工具，而是用 `write_file`/`edit_file` 寫 `brain/<id>/task.md` 作為產物，因此不映射 `TodoWrite`。
  - 修正一個預先存在的整合測試失敗：`notifyRunStopped` 在非整數 userId 時拋出 `SQLITE_MISMATCH` 並打斷 run 的收尾；`notifyUserIfEnabled` 改為捕捉後記錄 warn（通知為盡力而為）。
- **2.8 瀏覽器實測（chrome-devtools，`npm run dev`）**：
  - Antigravity：即時一輪（Bash / Read / 失敗的 Bash / Write）與重新載入後逐字一致；權限被拒（Default 模式）也正確顯示為錯誤。
  - Codex 歷史：Bash、TodoWrite、Edit/Write、CodeRun、TerminalInput 皆有專用渲染，沒有原始 JSON；多段 `apply_patch` 拆成每檔一張卡片；以前被當成成功的 `Process exited with code N` 失敗現在正確標為錯誤。
  - Codex 即時：多檔修改（含刪除）逐檔渲染並正確完成；與重新載入後結構相同。剩下的差異來自資料本身：歷史 rollout 不記錄工作目錄，輸出文字格式不同。
  - 實測中發現並修正三個既有問題：
    1. `WebSocketContext` 的單值 `latestMessage` 會讓連續到達的訊息互相覆蓋（串流掉字、拆分後的工具完成事件遺失而卡在 Running）→ `onmessage` 改用 `flushSync`。
    2. `openai-codex.js` 以 `streamed.has(item.id)` 決定是否送 `stream_end`，但 0.163 的 delta `itemId` 與 `item.id` 格式不同，`stream_end` 從未送出，串流氣泡跨訊息累加並與最終文字重複 → 改為「有未收尾串流」旗標。
    3. app-server 的 `commandExecution.command` 帶 shell 包裝（`/bin/zsh -lc '…'`），與歷史 `exec_command` 不一致 → mapper 的 `unwrapShellCommand` 拆掉外層。
  - 降級卡片標題為空時不再顯示孤立的 `/` 分隔符。
  - 尚未處理（非本變更範圍）：側邊欄與頁首仍以 Claude 圖示顯示 Antigravity 會話；Antigravity 的 `<SYSTEM_MESSAGE>`（伺服器重啟通知）會被當成助手文字顯示。
- **階段二 · Gemini 下線（3.2–3.7）**：
  - `shell-session-lookup` 的記憶體查詢只服務 gemini（`sessionManager`），已整個刪除，終端續接改為 `server/index.js` 內一行「查索引帶上 `cliSessionId`」。
  - 啟動遷移 `removeRetiredGeminiSessions` 刪除 `sessions` 表 `provider='gemini'` 的索引列（收藏是同表的 `isStarred` 欄位，一併清除）；專案清單遇到未註冊 provider 的列時略過並每個 provider 警告一次。
  - 小寫 `exit_plan_mode` 確認只出現在 gemini（本機 Claude 歷史 43 個檔案全用 `ExitPlanMode`），一併刪除。
  - 刪除 `GeminiLogo` 後改為 `AntigravityLogo`（沿用 `gemini-ai-icon.svg`）；順手修正 Antigravity 會話在側邊欄、頁首、輸入框提示、狀態列錯用 Claude 名稱/圖示的問題（改以 provider id 取 i18n 鍵）。
  - **保留**：`cloudcli sandbox -a gemini`（`server/cli.js` 與 `docker/gemini/`）是在 docker 裡跑 CLI 的獨立功能，與聊天 provider 無關；`openspec/specs/gemini-*` 於 archive 時依 delta spec 移除。
- **階段二 · 執行層（4.1–4.8）**：
  - `IProviderRuntime` 的 writer 用結構型別 `ProviderRuntimeWriter`，WebSocket 與 `routes/agent.js` 的 SSE writer 共用。轉接層在方法內才讀取 import 的根目錄函式，避開 `claude-sdk.js` ↔ provider registry 的 ESM 循環（伺服器啟動冒煙測試通過）。
  - eslint `backend-legacy-runtime` 元素加入四個根目錄執行檔，允許 provider 轉接層 import。
  - 分派層：未知訊息類型與未註冊 provider 一律回 `error`；`get-pending-permissions` 只在有 provider 擁有該活躍會話時回覆（空回覆會清掉其他 provider 經即時流重放的審批）。
  - `shared/providers.ts` 是 provider 清單唯一來源：前後端 `LLMProvider`、前端 `PermissionMode` 皆由此推導；另含 `settingsStorageKey`。統一送出時帶 superset 參數：經確認 `options.skipPermissions` 只有 Cursor 讀、Antigravity 讀 `permissionMode`、Codex 忽略 `toolsSettings`，行為與改動前一致。
  - 4.8 瀏覽器實測：Claude、Codex、Antigravity 的送出、中斷（每次正好一個 `complete(aborted)`）、執行中重新整理後恢復「執行中」並正常收尾全部通過。**Cursor 未實測**（本機未安裝 `cursor-agent`），僅由分派層單元測試覆蓋。
- **階段二 · 資料層（5.1–5.5）**：
  - `scanStateDb` 只剩 `app_config` 的 `scan_cursor:<provider>`；尚未有該鍵時讀舊值（antigravity 讀 `antigravity_last_scanned_at`，其他讀 `scan_state`），首輪同步成功後即寫入新鍵。舊的 `scan_state` 表保留不動，回滾時舊程式碼仍可用。
  - `projects` 模組沒有直接依賴 provider registry（`providers → projects` 已有一條執行期 import，避免加深循環），分組鍵改用 `shared/providers.ts` 的 `PROVIDER_IDS`，與 registry 型別同源。
  - 前端 `src/utils/projectSessions.ts` 提供 `getProjectSessions(project, provider?)`（帶 `__provider`）與 `mapProjectSessions`；順手修正命令面板中非 Antigravity 的會話少了 `__provider`。
  - 瀏覽器確認：每個 provider 的游標在啟動同步後各自寫入；側邊欄混合 provider 的會話清單、由 URL 還原會話與 provider 均正常。
- **階段二 · 全文檢索（6.1–6.5）**：
  - `SearchableMessage.role` 另有 `'summary'`：只用來產生結果的會話摘要，以最後一則為準，不參與比對。這樣 Claude 的 summary 行、leafUuid 與 compact summary 優先序，以及 Codex「以最後一則使用者訊息為摘要」都留在各自的 facet，搜尋服務只剩「summary → 最後一則使用者 → 最後一則助手」的通用規則。
  - 基準比對：以真實資料庫的 Claude 540 筆、Codex 114 筆會話跑 10 組關鍵字，搬移前後的命中會話與片段相同；唯一差異是另一個視窗在兩次執行之間寫入的會話。
  - Antigravity 只搜尋 `USER_INPUT`（取 `<USER_REQUEST>` 內文）與 `PLANNER_RESPONSE` 的 `content`，不含工具輸出（`GENERIC`）與 `SYSTEM_MESSAGE`。
  - **cursor（6.4）**：開發機的 `~/.cursor/projects` 與 `~/.cursor/chats` 皆為空，也沒有安裝 cursor-agent，無法以真實資料確認，所以先不實作。現有 synchronizer 會從這些 JSONL 的 `role: 'user'` 行讀 `message.content[0].text` 當會話名稱，可見至少有使用者文字；取得真實檔案後確認助手訊息的形狀，再補 `extractSearchableMessages`。在那之前搜尋回應的 `unsearchableProviders` 為 `['cursor']`，側邊欄會顯示提示。
- **階段三 · Codex 協議型別（7.1–7.3）**：
  - `scripts/codex-gen-types.mjs` 以「用到的方法清單」為入口：從生成的 `ClientRequest` / `ServerNotification` / `ServerRequest` 讀出各方法的參數型別（回應型別依 `XxxParams` → `XxxResponse` 慣例），沿 import 收集相依檔，共 136 個檔案（完整生成 747 個）。完整的 union 會拉進 426 個檔案，所以 `protocol/index.ts` 改生成只含用到方法的 `ClientRequestMap`、`ServerNotification`、`ServerRequestMap`，而不是提交完整 union。相對 import 補上 `.js`，以符合後端的 NodeNext 解析。
  - 型別立即抓到的差異：`initialize` 的 `clientInfo.title` 與 `capabilities.requestAttestation` 在 0.163 為必填（補上 `null` / `false`）；審批參數已沒有 `availableDecisions`（只有 0.155 會送），程式本來就會退回預設集合，改為明確當成舊欄位讀取；`webSearch.action` 是依種類帶 `query` 或 `url` 的 union。
  - `openai-codex.ts` 原本直接 import 其他模組內部檔案，轉成 `.ts` 後被 boundaries 規則檢查到，改從 `providers`、`websocket` 的入口引入；`notification-orchestrator.js` 歸入 `backend-legacy-runtime`。
  - 以真實 codex 0.163.0 跑一輪（建立會話 → Bash 工具 → 回覆）確認：`session_created`、`tool_use`、`status`、串流、`text`、`complete` 皆正常。
- **階段三 · 執行中插話（8.0–8.5）**：
  - **8.0 實測（codex 0.163.0）**：`turn/steer` 回傳 `{ turnId }`（同一輪）。插話內容寫進 rollout，形狀與一般使用者訊息相同：`response_item/message(role: user)` 加上 `event_msg/item_completed`（`UserMessage`），時間位置在送出插話的當下，也就是工具呼叫之前。現有的 rollout 映射本來就會把它還原成使用者訊息，所以歷史映射不需要修改。
  - 前置條件與 RPC 呼叫抽成 `steerRun(state, …)`，方便以假 run 測試；任何失敗只回傳 `{ ok: false, reason }`，不呼叫 `fail()`。
  - WebSocket 回覆 `steer-accepted` / `steer-rejected`，帶回前端送出的 `clientId`。前端收到 accepted 才加入使用者訊息並清空輸入；rejected 時保留輸入並顯示錯誤訊息。等待回覆期間不能再送第二則。
  - 瀏覽器實測：Codex 執行 `sleep 20` 期間插話，這一輪沒有中斷，最終回覆遵循插話內容；重新整理後插話仍在原位置。Claude 的送出按鈕在執行中仍為停用（`midTurnSteer: false`）。
  - 已知、與插話無關：Codex 執行中，即時畫面會把第一則助手文字與工具卡片各顯示兩次，重新整理後正常。沒有插話時也會發生，另行處理。

## Open Questions

- cursor 的 `~/.cursor/projects/**.jsonl` 是否含有可搜尋的訊息文字？（D5）**未能確認**：開發機沒有 cursor 資料，暫不實作，見上方「階段二 · 全文檢索」。
- ~~Antigravity 是否會產生與 gemini 同名的工具？~~ **會**：`read_file`、`write_file` 與 gemini 工具設定同名。但 Antigravity 已在後端映射為 `Read`/`Write`，前端不再依賴這些名稱，因此 gemini 專用工具設定可以全部刪除（3.1）。
- ~~Antigravity CLI 是否會在 `brain/<id>/` 頂層寫出 `.md` 產物？~~ **會**：實測寫出 `task.md`（附 `task.md.metadata.json`，含 `summary`、`updatedAt`、`userFacing`），頂層另有 `scratch/`、`.user_uploaded/`、`.system_generated/` 目錄。第 9 組依 D15 實作，只讀頂層 `.md`。
- `turn/steer` 的插話內容是否寫入 rollout？條目形狀為何？（D9 的開關，任務 8.1 實測）
- 新版 Claude 的子 agent transcript 是否仍為主 transcript 同目錄下的 `agent-<id>.jsonl`？（D1a，任務 2.9 確認）
- 插話時，若使用者已經按下中斷但 turn 尚未結束，應該拒絕還是排進佇列？目前的決定是拒絕（D9），若有其他想法請在實作前提出。
- ~~Antigravity 的真實工具名、參數形狀、錯誤欄位是什麼？~~ 見 Implementation Notes。
- ~~Antigravity 的 `tool_info` 是否有可辨識的錯誤欄位？~~ 有：`tool_info.error.message` 與指令結束碼。
