## 1. 共用型別與校驗

- [ ] 1.1 新增 `shared/multiAgent.ts`：`WorkflowNode`/`WorkflowDef`/`ChatMember`/`ChatRules`/`ChatroomDef`/`MultiAgent` 型別與預設群規常數
- [ ] 1.2 實作 `validateDefinition(kind, def)`：節點 1–12、成員 1–8、id 唯一、依賴存在且無環、provider/模型在 `shared/modelConstants.js` 清單中；回傳錯誤列表
- [ ] 1.3 實作 `layerWorkflow(def)`（Kahn 分層），附單元測試覆蓋：線性、分叉、匯合、環、缺失依賴

## 2. 後端持久化

- [ ] 2.1 `server/modules/database/schema.ts` 新增 `multi_agents`、`multi_agent_runs`、`multi_agent_messages` 三張表（`CREATE TABLE IF NOT EXISTS`）並在 init 中建立
- [ ] 2.2 新增 `repositories/multi-agents.db.ts`：CRUD（依 user_id 隔離）、run 讀寫、訊息追加/分頁讀取、刪除時級聯清除
- [ ] 2.3 repository 整合測試（建立、更新定義、列表排序、刪除級聯）

## 3. 後端 API 與工作目錄

- [ ] 3.1 新增 `server/modules/multi-agent/` 模組與 `multi-agent.routes.ts`：`GET/POST /api/multi-agent`、`GET/PATCH/DELETE /:id`、`PUT /:id/definition`（後端再次校驗，執行中拒絕）
- [ ] 3.2 建立時決定 `workspace_path`：帶入當前專案路徑，否則建立 `~/.cloudcli/multi-agent/<id>/`
- [ ] 3.3 在 `server/index.js` 掛載路由（走既有 JWT 中介層），更新 `server/modules/MODULES.md`

## 4. 工作流執行器

- [ ] 4.1 實作 `WorkflowRunner`：建立 run、就緒節點並行（上限 3）、組裝節點提示（instruction + 上游輸出截斷）、經 `providerRegistry` runtime 執行
- [ ] 4.2 自訂收集 writer：累積 assistant 文字、計算階段式/漸近式進度、`complete`/錯誤時判定成功或失敗；失敗節點下游標記 skipped
- [ ] 4.3 狀態變化寫入 `node_states_json`，並經聊天 WS 推送 `multi-agent-run` 事件給該使用者所有連線
- [ ] 4.4 `POST /:id/runs`、`POST /:id/runs/:runId/stop`、`GET /:id/runs/latest`；停止時對執行中節點呼叫 `runtime.abort`
- [ ] 4.5 服務啟動時把 `running` 的 run/節點標記為失敗（已中斷）
- [ ] 4.6 runner 單元測試（mock runtime）：依序執行、並行上限、失敗傳播、停止

## 5. 聊天室調度器

- [ ] 5.1 實作 `@` 解析（成員名稱、所有人、未 @ 預設行為），附單元測試
- [ ] 5.2 實作 `ChatroomDispatcher`：依序讓目標成員發言，組裝 persona + 群規 + 硬限制說明 + 最近紀錄；每成員保存並 resume 自己的 provider sessionId
- [ ] 5.3 後端強制限制：`maxReplyChars` 截斷、`allowAiMentions` 佇列擴展、`maxAiRepliesPerTurn` 達上限插入系統訊息；成員以禁用工具模式執行
- [ ] 5.4 `POST /:id/messages`、`POST /:id/messages/stop`、`GET /:id/messages`；串流經 WS 推送 `multi-agent-message`
- [ ] 5.5 dispatcher 單元測試（mock runtime）：@ 單人、@所有人、截斷、AI 互 @ 上限、停止

## 6. 側邊欄

- [ ] 6.1 `SidebarSearchMode` 將 `'conversations'` 改為 `'multiAgent'`，讀取舊值回退為 `'projects'`
- [ ] 6.2 `SidebarHeader` 桌面與行動版切換按鈕改為「多 Agent」（lucide `Bot` 圖示）
- [ ] 6.3 移除 `useSidebarController` 與 `SidebarContent` 中的側邊欄對話全文搜尋邏輯與渲染（保留 ⌘K 的搜尋）
- [ ] 6.4 新增 `src/components/multi-agent/` 模組（五段式），實作 `useMultiAgents` hook（列表、建立、重新命名、刪除）與 `src/utils/api.js` 對應方法
- [ ] 6.5 實作 `MultiAgentList`：類型圖示、名稱、更新時間、名稱過濾、空狀態、項目操作選單（重新命名/刪除確認）
- [ ] 6.6 底部固定「+ 建立」按鈕與類型選擇彈出選單（聊天室/工作流），建立草稿後導向 `/multi-agent/:id`

## 7. 路由與頁面骨架

- [ ] 7.1 `src/App.tsx` 新增 `/multi-agent/:id` 路由；`AppContent`/`MainContent` 依路由渲染 `MultiAgentPage`
- [ ] 7.2 `MultiAgentPage`：載入定義，依 kind 與定義是否為空分派到 BuilderView / WorkflowCanvas / ChatroomView；頁首（名稱、類型徽章、用 AI 修改、刪除）沿用 `MainContentHeader` 風格

## 8. 建立器（複用聊天頁）

- [ ] 8.1 `ChatInterface` 新增可選 `builder` prop：首次送出前附加建立器系統說明（依 kind 選擇提示範本，放 `multi-agent/constants`），以多 Agent 工作目錄作為 cwd
- [ ] 8.2 訊息渲染：偵測 `multi-agent-json` 區塊並以 `DefinitionPreviewCard` 取代原文（工作流迷你流程圖 / 聊天室成員清單），校驗錯誤顯示與「讓 AI 修正」
- [ ] 8.3 「建立」按鈕呼叫 `PUT definition`，成功後頁面切換；保存建立器 sessionId 供「用 AI 修改」返回
- [ ] 8.4 測試：不傳 `builder` 時 ChatInterface 行為不變；JSON 區塊解析（合法、非法、多個區塊取最後一個）

## 9. 工作流頁面

- [ ] 9.1 `WorkflowCanvas`：依 `layerWorkflow` 絕對定位節點卡片 + SVG 貝茲連線，可拖曳平移
- [ ] 9.2 `WorkflowNodeCard`：標題、模型徽章、底部進度條、狀態圖示（等待/執行中/✓/✗/略過）
- [ ] 9.3 `NodeDetailPanel` 右側抽屜：可編輯執行內容、模型下拉（按 provider 分組）、執行中唯讀並顯示節點輸出
- [ ] 9.4 頂部工具列：開始（確認彈窗顯示將呼叫的節點數與模型）、停止、整體狀態；`useWorkflowRun` hook 訂閱 WS 事件並在進入頁面時還原最新 run

## 10. 聊天室頁面

- [ ] 10.1 `ChatroomView`：訊息列表（使用者靠右、成員靠左帶頭像/名稱/模型）、串流渲染、Markdown 復用聊天頁的訊息渲染元件
- [ ] 10.2 輸入框：`@` 候選彈出（成員 + 所有人）、送出、停止本輪
- [ ] 10.3 `ChatroomSidebar`：成員清單（切換模型、編輯人設）、群聊設定表單（群規文字、最大字數、AI 互相 @、每輪上限、未 @ 預設行為），可收合
- [ ] 10.4 `useChatroom` hook：分頁載入歷史、訂閱 `multi-agent-message` WS 事件

## 11. 國際化、文件與驗證

- [ ] 11.1 `src/i18n/locales/*` 新增 `multiAgent` 文案（至少 zh-CN、zh-TW、en），移除不再使用的 `search.modeConversations` 相關鍵
- [ ] 11.2 更新 `src/components/COMPONENTS.md`、`server/modules/MODULES.md`
- [ ] 11.3 `npm run typecheck`、`npm run lint`、`npm run build`、相關測試全部通過
- [ ] 11.4 瀏覽器實測深淺色主題與行動版：建立工作流 → 編輯節點 → 執行看到進度與 ✓/✗；建立聊天室 → @角色 / @所有人 → 群規限制生效
