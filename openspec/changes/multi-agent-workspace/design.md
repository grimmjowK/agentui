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

### D2 資料模型：一張定義表 + 執行表 + 群聊訊息表
```
multi_agents(id TEXT PK, user_id, kind 'chatroom'|'workflow', name, definition_json, workspace_path, created_at, updated_at)
multi_agent_runs(id TEXT PK, multi_agent_id, status, node_states_json, started_at, finished_at)   -- 工作流執行
multi_agent_messages(id INTEGER PK, multi_agent_id, seq, author_kind 'user'|'member'|'system', member_id, content, created_at) -- 聊天室
```
`definition_json` 以 TypeScript 型別約束，前後端共用（放 `shared/multiAgent.ts`）：
```ts
type WorkflowNode = { id; title; instruction; provider; model; dependsOn: string[] };
type WorkflowDef  = { nodes: WorkflowNode[] };
type ChatMember   = { id; name; persona; provider; model; color? };
type ChatRules    = { text: string; maxReplyChars: number; allowAiMentions: boolean; maxAiRepliesPerTurn: number };
type ChatroomDef  = { members: ChatMember[]; rules: ChatRules };
```
節點/成員各自綁 provider+model，因此「模型列表切換」直接複用 `shared/modelConstants.js` 的各 provider 模型清單。
- 替代方案：每節點一個表 → 定義總是整體讀寫，JSON 欄位更簡單；執行狀態另存在 runs 表，避免改定義時污染歷史。

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
- ponytail: 節點數 ≤ 12 時分層佈局足夠；需要手動拖拽排版再引入 reactflow。

### D5 工作流執行：後端 runner，按層並行，WS 推送節點狀態
`POST /api/multi-agent/:id/runs` 建 run，`WorkflowRunner` 在後端記憶體中執行：
- 就緒節點（依賴全部 succeeded）並行啟動，每個節點一次 `runtime.start(prompt, { cwd, model, permissionMode })`，prompt = 節點 instruction + 各上游節點最終輸出摘要（截斷至固定長度）。
- writer 為自訂收集器：累積 assistant 文字作為節點輸出；收到 `complete`/錯誤時標記 succeeded/failed。
- **進度**：provider 不回報百分比，進度條採「階段式」：等待 0%、啟動 10%、每收到一個串流事件逐步逼近 90%（漸近式）、完成 100%。失敗節點的所有下游標記 `skipped`。
- 狀態變化透過聊天 WS 推送 `{ type: 'multi-agent-run', runId, nodeId, state, progress, output? }` 給該使用者所有連線，並寫入 `node_states_json`，重新整理頁面可還原。
- `POST /runs/:runId/stop` 對所有執行中節點呼叫 `runtime.abort`。
- 權限：節點使用定義中的 provider 與使用者在該 provider 的預設權限模式；需審批的工具請求沿用現有全域審批收件匣（`get-pending-permissions`），不另做 UI。
- 替代方案：前端驅動執行 → 關掉頁面即中斷，且需多連線協調；後端驅動更可靠。

### D6 聊天室調度：後端 dispatcher + 硬性限制
`POST /api/multi-agent/:id/messages { content }`：
1. 存使用者訊息；解析 `@名稱` / `@所有人`。未 @ 任何人時預設 `@所有人`（可在設定中改為「不回覆」）。
2. 依序（非並行，保證群聊順序可讀）讓目標成員發言：prompt = 成員 persona + 群規文字 + 硬限制說明 + 最近 N 則群聊紀錄（截斷）+ 「請以 {name} 身份回覆」。每個成員維護自己的 provider sessionId（存在定義外的 `member_sessions` JSON），以 resume 延續上下文，只送增量紀錄。
3. 回覆超過 `maxReplyChars` 時後端截斷並附「…」。
4. `allowAiMentions` 為真時，成員回覆中的 `@其他成員` 會把對方加入佇列；本輪 AI 回覆總數達 `maxAiRepliesPerTurn` 即停止，並插入一則系統訊息「已達本輪發言上限」。
5. 串流透過 WS 推送 `{ type: 'multi-agent-message', memberId, delta|final }`。使用者可隨時「停止」終止本輪。
- 成員以純對話模式執行（Claude 用 `permissionMode: 'plan'`/禁用工具、其他 provider 用各自唯讀設定），避免群聊觸發檔案操作。
- 替代方案：只靠提示詞約束 → 無法真正防止 token 浪費；硬限制必須在後端執行。

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
- 工作流節點是否需要允許工具（寫檔、執行指令）？目前預設沿用 provider 預設權限，可能觸發審批。
