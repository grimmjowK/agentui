## Context

- 側邊欄頂部有「專案 / 對話 / 封存」三段切換（`SidebarSearchMode = 'projects' | 'conversations' | 'archived'`），其中「對話」只是把搜尋框切成全文搜尋，列表內容與「專案」相同。全文搜尋能力在命令面板（`command-palette/sources/useSessionMessageSearch.ts`）已有獨立入口。
- 所有 AI 執行都經 `providerRegistry.get(id).runtime.start(command, options, writer)`，writer 是 `{ send(data) }` 結構；聊天 WS 與 `/api/agent` 皆以 `LoggingWriter` 包裝並寫入 `session_messages`。這是多 Agent 唯一應依賴的執行入口。
- 聊天頁 `ChatInterface` 已有 provider/模型選擇（`useChatProviderState` + `ModelSelector`，模型按 session 記憶）、串流渲染、權限審批。
- 前端無流程圖/圖形依賴；後端 SQLite（better-sqlite3），schema 以 `CREATE TABLE IF NOT EXISTS` 演進。

## Goals / Non-Goals

**Goals:**
- 側邊欄「對話」→「多 Agent」，列表 + 建立入口。
- 建立過程完全複用聊天頁，由 AI 依對話生成結構化定義。
- 工作流：流程圖、節點編輯、DAG 執行、節點進度與結果。
- 聊天室：群聊頁、成員側欄、@ 調度、後端強制的 token 防護。
- 不新增 npm 依賴；UI 與現有客戶端風格一致。

**Non-Goals:**
- 拖拽式流程圖編輯器（新增/刪除節點、連線）——第一版只能透過再次對話 AI 修改結構，畫布上只編輯節點內容與模型。
- 工作流條件分支、迴圈、定時觸發。
- 跨使用者共享聊天室/工作流。
- 聊天室成員使用工具（讀寫檔、執行指令）——第一版成員純文字對話。

## Decisions

### D1 側邊欄：替換 searchMode 而非新增第四段
`SidebarSearchMode` 的 `'conversations'` 改名為 `'multiAgent'`，按鈕圖示改 `Bot`/`Users`，文案「多 Agent」。在該模式下 `SidebarContent` 不渲染專案列表，改渲染 `MultiAgentList`（搜尋框過濾名稱），底部固定「+ 建立」按鈕。移除 `useSidebarController` 內側邊欄的對話 SSE 搜尋與 `SidebarContent` 的對話結果渲染；全文搜尋保留在 ⌘K。
- 替代方案：保留「對話」新增第四段 → 使用者明確要求移除，且三段已擁擠。

### D2 資料模型：定義、執行快照與群聊回合
```
multi_agents(id TEXT PK, user_id, kind 'chatroom'|'workflow', name, definition_json, definition_version, builder_session_json, member_sessions_json, workspace_path, created_at, updated_at)
multi_agent_runs(id TEXT PK, multi_agent_id, status, definition_version, definition_snapshot_json, node_states_json, started_at, finished_at)   -- 工作流執行
multi_agent_turns(id TEXT PK, multi_agent_id, client_request_id, status, definition_snapshot_json, started_at, finished_at)
multi_agent_messages(id TEXT PK, multi_agent_id, turn_id, seq, author_kind 'user'|'member'|'system', member_id, author_snapshot_json, content, status, finish_reason, created_at) -- 聊天室
```
`definition_json` 以 TypeScript 型別約束，前後端共用（放 `shared/multiAgent.ts`）：
```ts
type WorkflowNode = { id; title; instruction; provider; model; dependsOn: string[] };
type WorkflowDef  = { nodes: WorkflowNode[] };
type ChatMember   = { id; name; persona; provider; model; color? };
type ChatRules    = { text: string; maxReplyChars: number; allowAiMentions: boolean; maxAiRepliesPerTurn: number; unmentionedBehavior: 'all'|'none' };
type ChatroomDef  = { members: ChatMember[]; rules: ChatRules };
```
節點/成員各自綁 provider+model。選單與後端驗證都經現有 `providerModelsService` / provider models API 取得同一份有效清單；`shared/modelConstants.js` 僅作服務既有的 fallback，不作另一套硬編碼白名單。共用 validator 負責結構，另注入清單進行模型校驗；後端保存與啟動前再次校驗。查詢失敗時使用服務回傳的 fallback 並顯示來源；不在 fallback 的模型顯示「暫時無法驗證」，保留輸入／既有定義但拒絕該次保存或啟動，允許重新整理清單後重試。
- `definition_version` 每次保存遞增；run 建立時以交易保存完整定義快照（含節點 id、標題、指令、provider、model、依賴），runner 與歷史檢視只讀快照。修改目前定義不重新解釋舊 run；提供 run 列表及指定 run 詳情 API。
- `builder_session_json` 保存 provider/sessionId。`member_sessions_json` 以 memberId 為鍵保存 provider、model、sessionId、設定指紋（人設、群規、工具政策）與 `last_delivered_seq`。此欄位由後端管理，不接受定義 JSON 覆寫。
- 群聊 `seq` 在同一聊天室唯一且遞增；訊息保存當時名稱/provider/model 快照，避免修改或移除成員破壞歷史。`client_request_id` 在同一聊天室唯一，用於送出重試去重；每聊天室最多一個 running/stopping 回合，以資料庫唯一性約束與交易保護。
- 替代方案：每節點一個表 → 定義整體讀寫較簡單，但執行必須保存不可變快照。

### D3 建立器：ChatInterface 加 `builder` 模式，AI 輸出 fenced JSON
建立入口建立一個 **草稿**（`multi_agents` 一列，`definition_json = null`），導向 `/multi-agent/:id`；頁面發現定義為空時渲染 `ChatInterface` 並傳入 `builder={{ kind, draftId }}`。builder 模式只做三件事：
1. 首次送出時在 prompt 前附加建立器系統說明（角色、輸出格式範例、限制：節點 ≤ 12、成員 ≤ 8、`dependsOn` 必須無環）。
2. 渲染助理訊息時，偵測 ```` ```multi-agent-json ```` 區塊，以「預覽卡片」替代原文（工作流顯示迷你流程圖、聊天室顯示成員清單），卡片上「建立」按鈕。
3. 點「建立」→ 前端用共用 validator 校驗 → `PUT /api/multi-agent/:id/definition` → 頁面切換為流程圖或群聊。
建立器對話本身是一般 provider session（工作目錄見 D7），方便使用者多輪調整；完成後保留 sessionId，後續「用 AI 修改結構」可回到這段對話。
- 替代方案：另寫一個建立頁/表單 → 使用者明確要求複用聊天頁且不搭建其他頁面。
- 替代方案：讓 AI 呼叫工具寫檔 → 跨 provider 工具能力不一，fenced JSON 對四家 provider 都可行。

### D4 工作流流程圖：自繪分層佈局，不引入 reactflow
依 `dependsOn` 做拓樸分層（Kahn），每層一列，節點用絕對定位卡片，連線用一個覆蓋 SVG 畫三次貝茲曲線；容器可捲動，支援滑鼠拖曳平移（不做縮放）。節點卡片：標題、模型徽章、下方 2px 進度條、右上角狀態圖示（Loader / Check / X）。點擊打開右側抽屜 `NodeDetailPanel`：可編輯 instruction（textarea）、模型下拉（provider 分組），儲存即 `PUT definition`。執行中禁止編輯。
- 替代方案：reactflow → 功能強但新增依賴與樣式體系；第一版只讀拓樸 + 少量節點，自繪 < 200 行。
- 取捨: 節點數 ≤ 12 時分層佈局足夠；需要手動拖拽排版再引入 reactflow。

### D5 工作流執行：後端 runner，按層並行，WS 推送節點狀態
`POST /api/multi-agent/:id/runs` 以交易建立定義快照與 run；同一工作流已有 running/stopping run 時回傳 409，`WorkflowRunner` 在後端記憶體中執行：
- 就緒節點（依賴全部 succeeded）並行啟動，每個節點一次 `runtime.start(prompt, { cwd, model, toolPolicy, permissionMode })`，prompt = 節點 instruction + 各上游節點最終輸出摘要（截斷至固定長度）。
- writer 為自訂收集器：累積 assistant 文字作為節點輸出；收到 `complete`/錯誤時標記 succeeded/failed。
- **進度**：provider 不回報百分比，進度條採「階段式」：等待 0%、啟動 10%、每收到一個串流事件逐步逼近 90%（漸近式）、完成 100%。失敗節點的所有下游標記 `skipped`。
- 狀態變化透過聊天 WS 推送 `{ type: 'multi-agent-run', runId, nodeId, state, progress, output? }` 給該使用者所有連線，並寫入 `node_states_json`，重新整理頁面可還原。
- `POST /:id/runs/:runId/stop` 對所有執行中節點呼叫 `runtime.abort(sessionId, writer)`；writer 帶入 userId 並記錄 runtime 的 session 識別。依 `emitsTerminal` 補齊一次終止事件，停止後不得再啟動下游，遲到 complete 不得覆寫停止狀態。
- 權限：第一版工作流節點與聊天室都使用 D6 的 `toolPolicy: none`；不繼承 provider 預設工具權限。建立器仍為一般聊天會話並沿用原有權限 UI。此版工作流僅處理傳入文字，抓取 issue、讀寫檔案與命令執行不在範圍；需工具的模型選項不可執行。
- 替代方案：前端驅動執行 → 關掉頁面即中斷，且需多連線協調；後端驅動更可靠。

### D6 聊天室調度：後端 dispatcher + 硬性限制
`POST /api/multi-agent/:id/messages { content, clientRequestId }`：
1. 先驗證目標成員模型與禁用工具能力（失敗不保存訊息或啟動回合），再在同一交易中查重並取得聊天室回合鎖、保存使用者訊息與 running turn。重送相同 clientRequestId 回傳原 turn；不同請求在 running/stopping 期間回傳 409，不落訊息、不排隊。定義／成員／群規修改在此期間也回傳 409。
2. 解析 `@名稱` / `@所有人`，未 @ 時依 `unmentionedBehavior` 處理。成員名稱必須唯一，不得為保留名稱「所有人」。目標成員依序發言，整個回合使用建立時的定義快照；失敗成員保存錯誤系統訊息並繼續其餘佇列，發言嘗試也計入上限。
3. prompt = persona + 群規 + 硬限制說明 + 群聊紀錄。首次／重建 session 重播最近 50 則、合計至多 20,000 Unicode code points（取最新內容並標記截斷）；續接只送 `last_delivered_seq` 之後的紀錄，套用相同上限。成功完成後才推進游標；provider/model/人設/群規/工具政策改變、resume 失敗、字數截斷、停止或錯誤時，清除該成員 session 及游標，下次以已保存群聊重建，不沿用隱藏或未完成輸出。切換模型即使 provider 不變也重建，避免 Cursor resume 忽略 model。
4. `maxReplyChars` 是顯示／保存上限（Unicode code points，包含結尾「…」），預設 800、範圍 1–8,000；`maxAiRepliesPerTurn` 預設成員數、範圍 1–32，後端拒絕非整數與越界值。串流輸出保留一個字元位置給截斷標記，不得先送出超限文字。達上限立即 abort，目前訊息只保存一次且 `finish_reason=length`，該次發言計入上限；等待 runtime 真正結束後才啟動下一位。超時也 abort：每位從啟動起最多 120 秒，等待審批或沒有文字仍計時。若 provider 支援輸出 token 預算，額外傳入 4,096 上限；字數與時間限制不宣稱是精確 token／費用上限，取消傳播前仍可能產生費用。
5. `allowAiMentions` 為真時，僅完整成功、未截斷的已保存回覆可擴展佇列。達 `maxAiRepliesPerTurn` 後不再呼叫模型並插入一次上限系統訊息。
6. 串流事件帶 `{ type: 'multi-agent-message', multiAgentId, turnId, messageId, memberId, eventSeq, kind: 'delta'|'final', content, finishReason? }`；回合另推送帶 multiAgentId/turnId 的狀態事件。只發給擁有者的連線；前端按識別過濾並以 eventSeq 去重，final 為權威完整內容。GET 訊息回傳持久化訊息與活動 turn／部分內容快照，重連依快照還原並補取缺口。
7. `POST /:id/messages/stop { turnId }` 只停止指定回合，重試冪等，不影響後來的新回合。先標記 stopping、清除待發言佇列，再 abort 執行中的 runtime；確認終止後標記 stopped。停止／達限後的遲到事件不得追加內容、擴展佇列或改寫終態。無法確認終止時維持 stopping 並拒絕新回合。服務重啟將活動回合標記 interrupted、清除 session 游標，不續跑；刪除聊天室先走相同停止流程再級聯刪除。

**工具政策契約**：擴充 runtime 能力 `supportsNoTools` 與 start 選項 `toolPolicy: 'none'|'default'`。`none` 必須在模型開始前禁止全部內建工具、MCP 與子 agent 工具；不能以提示詞、`plan`、唯讀 sandbox 或事後丟棄 tool event 代替。支援的 adapter 必須透過原生空工具清單／完整 deny 政策落實，並通過讀取、寫入、命令與 MCP 呼叫均未執行的契約測試。無法證明完整禁用時 `supportsNoTools=false`，後端回傳 `tools_disabled_unsupported` 且不啟動模型；選單顯示不支援原因。Claude、Codex、Cursor、Antigravity 各自驗證能力，第一版不承諾四家都可用；至少一個 adapter 通過實際整合測試才可交付。所有新 orchestrator 都必須持有可取消的 runtime session 識別（包含啟動階段），遵循 abort 的 `emitsTerminal` 語意。
- 替代方案：只靠提示詞或回覆後截斷 → 無法限制工具執行與持續生成，故採工具能力檢查、即時限長取消與超時。

### D7 工作目錄
每個多 Agent 有 `workspace_path`：建立時若側邊欄當前有選中專案則綁定該專案路徑，否則使用 `~/.cloudcli/multi-agent/<id>/`（自動建立）。建立器 session、工作流節點、聊天室成員都在此 cwd 執行。

### D8 路由與頁面
新增 `/multi-agent/:id`。`AppContent` 依路由決定主內容：一般專案/會話照舊；多 Agent 時渲染 `MultiAgentPage`，依 `kind` 與 `definition` 是否為空分派到 `BuilderView`（包 ChatInterface）/ `WorkflowCanvas` / `ChatroomView`。頁首沿用 `MainContentHeader` 樣式（標題、類型徽章、重新命名、刪除、「用 AI 修改」）。

### D9 視覺風格
只用現有 token：`bg-background`、`bg-muted/50`、`border-border/60`、`text-muted-foreground`、`rounded-xl`、`shadow-sm`；元件用 `shared/view/ui`（Button、Input、Tooltip）；圖示 lucide（`Bot`、`Workflow`、`MessagesSquare`、`Play`、`Square`、`Check`、`X`）。成員頭像為名稱首字 + 由 id 雜湊出的柔和色。狀態色：成功 `text-emerald-500`、失敗 `text-destructive`、執行中 `text-primary`。深淺色主題都需驗證。

## Risks / Trade-offs

- [AI 產出 JSON 不合法或含環] → 共用 validator 前後端都校驗，預覽卡片直接顯示錯誤並提供「讓 AI 修正」按鈕（自動把錯誤送回對話）。
- [工作流節點並行造成大量 token/費用] → 「開始」前顯示將呼叫的節點數與模型；同時並行上限 3。
- [聊天室 AI 互相 @ 空轉] → `allowAiMentions` 預設關閉、`maxAiRepliesPerTurn` 預設 = 成員數、`maxReplyChars` 預設 800，全部在後端強制。
- [後端重啟時執行中的 run 遺失] → 啟動時把 `running` 的 run/節點標記為 `failed (interrupted)`；不做斷點續跑。
- [進度條不是真實百分比] → 明確為階段式/漸近式，只代表「活著且在推進」；完成/失敗以圖示為準。
- [移除側邊欄對話搜尋影響習慣] → 搜尋框在「專案」模式下保留名稱過濾，全文搜尋提示改指向 ⌘K。
- [builder 模式侵入 ChatInterface] → 只透過可選 prop 注入兩個鉤子（prompt 前綴、訊息渲染覆寫），不傳時行為完全不變；加測試覆蓋。

## Migration Plan

- 新表 `CREATE TABLE IF NOT EXISTS`，無資料遷移。
- localStorage 中若存有 `searchMode = 'conversations'` 的舊值，讀取時回退為 `'projects'`。
- 回滾：還原前端即可，新表保留不影響舊版本。

## Open Questions

- 建立時沒有選中專案時，是否需要讓使用者在建立器中指定工作目錄？（目前預設專屬目錄）
- 後續版本若開放工作流工具，需要另提共用工作目錄的並行寫入隔離與審批設計；第一版已決定禁用。
