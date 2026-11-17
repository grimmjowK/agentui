## Why

側邊欄頂部的「專案 / 對話」切換其實只是兩種搜尋範圍，列出的都是同一批專案與會話，使用者感受不到差別；同時現有客戶端只能一次和一個 AI 一對一對話，無法讓多個 agent 分工協作。把這個沒有價值的「對話」入口換成「多 Agent」，用一個統一入口承載「聊天室」（多角色群聊）與「工作流」（多節點自動執行），讓使用者用自然語言就能搭建多 agent 協作。

## What Changes

- **BREAKING（UI）** 側邊欄移除「對話」模式切換按鈕，改為「多 Agent」。跨會話全文搜尋仍保留在命令面板（⌘K）中，不再出現在側邊欄。
- 選擇「多 Agent」後，側邊欄列出使用者建立的聊天室與工作流，底部固定一個「+ 建立」按鈕。
- 點擊「+ 建立」彈出兩個選項：聊天室 / 工作流。選擇後**直接複用現有聊天頁面**（ChatInterface + 模型選擇器），以「建立器」模式運行：使用者選模型、用對話描述需求，AI 產出結構化定義（JSON），使用者確認後落庫。
- 工作流建立後，進入的是**可視化流程圖**頁面（不再是聊天頁）：
  - 節點可點擊開啟詳情：預期執行內容（可編輯）、所用模型（可點擊從列表切換）。
  - 「開始」按鈕在後端按依賴順序執行整個工作流，上游輸出作為下游輸入；第一版節點禁用所有工具，只處理文字。
  - 每個節點下方有進度條，結束後顯示 ✓ / ✗ 狀態；可停止執行、查看節點輸出。
- 聊天室建立後，是類似一般聊天 App 的群聊頁面：
  - 右側欄列出成員（角色名、人設、底層 provider/模型）。
  - 輸入框支援 `@角色` 與 `@所有人`。
  - 右側欄提供「群聊設定」：自由文字群規 + 硬性限制（每則回覆最大長度、AI 之間是否可互相 @、每輪使用者訊息最多觸發的 AI 回覆數），防止 AI 互相空轉浪費 token。
- 後端新增多 Agent 持久化（SQLite 新表）、REST API，以及工作流執行器 / 聊天室調度器，皆經現有 `providerRegistry` 的 runtime 執行，不直接依賴各 provider 實作。runtime 新增可驗證的禁用工具能力；不支援的 provider 明確拒絕執行，第一版不保證四家全部可用。
- 整體 UI 沿用現有設計 token（Tailwind 主題色、`shared/view/ui` 元件、lucide 圖示），簡約一致；所有文案走 i18next。

## Capabilities

### New Capabilities
- `multi-agent-sidebar`: 側邊欄「多 Agent」模式——取代「對話」切換、列出聊天室/工作流、建立入口與類型選擇。
- `multi-agent-builder`: 複用聊天頁面，以對話方式讓 AI 生成聊天室/工作流定義，校驗並確認後落庫。
- `multi-agent-workflow`: 工作流的可視化流程圖、節點詳情編輯（內容/模型）、後端按 DAG 執行、節點進度與成功/失敗狀態。
- `multi-agent-chatroom`: 聊天室群聊頁面、成員側欄、@角色/@所有人調度、群聊規則與 token 防護限制。

### Modified Capabilities
<!-- 無：openspec/specs/ 下沒有涵蓋側邊欄或聊天調度的既有 spec -->

## Impact

- 前端：
  - `src/components/sidebar/`：`SidebarSearchMode` 的 `'conversations'` 改為 `'multiAgent'`；`SidebarHeader`、`SidebarContent`、`useSidebarController`（移除側邊欄的對話全文搜尋 SSE 邏輯）。
  - 新模組 `src/components/multi-agent/`（五段式：types/constants/hooks/utils/view），含列表、建立選單、建立器包裝、流程圖、節點詳情、聊天室、成員側欄、群聊設定。
  - `src/components/chat/`：ChatInterface 增加可選的 builder 模式參數（系統提示注入 + 解析定義區塊 + 確認卡片），一般聊天行為不變。
  - `src/components/main-content/`、`src/App.tsx`：新增 `/multi-agent/:id` 路由與主內容渲染分支。
  - `src/i18n/locales/*`：新增 `multiAgent` 命名空間文案。
- 後端：
  - `server/modules/database/schema.ts` + 新 repository：`multi_agents`、`multi_agent_runs`、`multi_agent_messages`、`multi_agent_turns` 表（`CREATE TABLE IF NOT EXISTS`）。
  - `server/shared/interfaces.ts` 與 provider runtime adapters：新增工具禁用能力與取消契約驗證。
  - 新模組 `server/modules/multi-agent/`：routes（CRUD、執行、停止、發送群聊訊息）、workflow runner、chatroom dispatcher。
  - `server/modules/websocket/`：聊天 WS 新增 `multi-agent-*` 事件推送（工作流節點狀態、群聊成員串流）。
- 依賴：不新增套件；流程圖用自繪分層佈局（SVG 連線 + 絕對定位節點）。
- 成本：工作流與聊天室都會呼叫多次模型，執行前 UI 需標示會呼叫的節點/成員數量；聊天室硬限制在後端強制，不只靠提示詞。
- 執行可靠性：執行保存完整定義快照；聊天室以持久化回合鎖、請求去重與具識別的串流隔離並行操作；模型切換重建 session；模型驗證沿用動態服務；回覆達限立即取消並有執行超時，字數限制不等同精確 token／費用預算。
