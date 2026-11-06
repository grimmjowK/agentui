## ADDED Requirements

### Requirement: Codex 即時與歷史渲染一致
系統 SHALL 讓 Codex 的即時事件（app-server `ThreadItem`）與歷史紀錄（rollout JSONL）經過同一套映射後產出 `NormalizedMessage`。同一個操作在對話中與重新載入歷史後，MUST 產生相同的 `toolName`、相同形狀的 `toolInput`，以及相同數量的工具訊息。

#### Scenario: 單檔修改在兩條路徑一致
- **WHEN** Codex 在對話中修改一個既有檔案，之後使用者重新載入該會話
- **THEN** 兩次渲染都顯示為該檔案的差異檢視，`toolName` 均為 `Edit`，且 `file_path` 相同

#### Scenario: 映射函式的同構測試
- **WHEN** 以同一次修改的 `ThreadItem` 與對應的 rollout `apply_patch` 條目分別呼叫映射
- **THEN** 兩者輸出的工具訊息在 `toolName`、`toolInput.file_path`、變更類型上完全相同

### Requirement: Codex 多檔案修改逐檔渲染
系統 SHALL 把一次涉及多個檔案的 Codex 修改拆成每個檔案一則工具訊息，並 MUST 區分新增、更新、刪除、改名四種變更類型。拆分出的每則工具訊息 MUST 擁有獨立的 `id` 與 `toolId`（格式為 `${itemId}:${index}`），且歷史載入時對應的結果輸出 MUST 展開配對至每一則拆分後的工具訊息。

#### Scenario: 一次修改三個檔案
- **WHEN** 一個 `fileChange` item 的 `changes` 包含一個新增、一個更新、一個刪除
- **THEN** 聊天頁顯示三則獨立的工具訊息（不會互相覆蓋），標題分別標示新增、更新、刪除，沒有任何一則顯示為原始 JSON

#### Scenario: 歷史中的多段 apply_patch 與結果配對
- **WHEN** rollout 中的 `apply_patch` 內容含有 `*** Add File`、`*** Update File`、`*** Delete File` 三段，隨後有一筆對應 `call_id` 的 `custom_tool_call_output`
- **THEN** 歷史載入產出三則對應的工具訊息，且三則工具訊息均能配對到對應的 `toolResult`

#### Scenario: 改名檔案
- **WHEN** 一項變更的 `kind` 為 `update` 且帶有 `move_path`
- **THEN** 工具訊息標示為改名，並同時顯示原路徑與新路徑

### Requirement: Codex 常見項目不得掉到原始 JSON
系統 SHALL 為 Codex 的計畫、網頁搜尋、推理、上下文壓縮項目提供專用渲染，MUST NOT 以原始 JSON 視圖顯示。

#### Scenario: 計畫更新
- **WHEN** Codex 送出 `plan` item、`turn/plan/updated` 通知，或歷史中出現 `update_plan`（參數為 `plan` 或 `steps` 任一形式）
- **THEN** 聊天頁以待辦清單渲染各步驟與狀態

#### Scenario: 網頁搜尋
- **WHEN** Codex 送出 `webSearch` item
- **THEN** 聊天頁以單行形式顯示搜尋關鍵字

#### Scenario: 推理內容
- **WHEN** Codex 在對話中送出已完成的 `reasoning` item
- **THEN** 聊天頁以可摺疊的思考區塊顯示，與歷史載入時的呈現相同

#### Scenario: 上下文壓縮
- **WHEN** Codex 送出 `contextCompaction` item
- **THEN** 聊天頁顯示壓縮邊界標記，與 Claude 的 `compact_boundary` 呈現相同

### Requirement: Codex 指令類工具的歷史渲染
系統 SHALL 在載入 Codex 歷史時，把指令類工具映射成專用渲染，MUST NOT 以原始 JSON 視圖顯示：`exec_command`、`shell_command`、`exec` 映射為 `Bash`（指令取 `cmd` 或 `command`，工作目錄取 `workdir`）；`write_stdin` 顯示為送往既有終端會話的輸入；`js` 顯示為帶 `title` 的程式碼執行卡片。

#### Scenario: exec_command
- **WHEN** rollout 中出現 `name` 為 `exec_command`、參數為 `{ "cmd": "ls -la", "workdir": "/repo" }` 的 `function_call`
- **THEN** 歷史載入以 `Bash` 單行指令形式顯示 `ls -la`，並能配對到對應的 `function_call_output`

#### Scenario: write_stdin 只輪詢不送字元
- **WHEN** rollout 中出現 `write_stdin`，參數只有 `session_id` 與 `yield_time_ms`、沒有 `chars`
- **THEN** 卡片標示為等待終端輸出，不顯示空白輸入，也不顯示原始 JSON

#### Scenario: js
- **WHEN** rollout 中出現 `js`，參數為 `{ "title": "統計", "code": "..." }`
- **THEN** 卡片標題為「統計」，程式碼預設收合

### Requirement: 歷史映射相容多個 Codex 版本
系統 SHALL 正確解析 Codex CLI 0.143 至目前版本寫出的 rollout。映射測試的 fixture MUST 至少涵蓋最舊與最新兩個版本、以 `exec` 與 `exec_command` 兩種指令工具寫出的會話。

#### Scenario: 舊版會話
- **WHEN** 以 0.143 版寫出的 rollout fixture 執行歷史解析
- **THEN** 指令、檔案修改、計畫的渲染結果與變更前相同或更好，不出現新的原始 JSON 項目

### Requirement: Claude 子 agent 工具名相容
系統 SHALL 把 Claude 的 `Agent` 與舊名 `Task` 一視同仁，皆以可展開的子 agent 容器渲染，並附上該子 agent 的工具呼叫。

#### Scenario: 新版 Agent 工具
- **WHEN** Claude 會話中出現 `name` 為 `Agent` 的工具呼叫，其結果帶有 `agentId`
- **THEN** 聊天頁以子 agent 容器渲染，展開後可看到子 agent 的工具呼叫，與 `Task` 的呈現相同

### Requirement: 存量會話的渲染品質驗收
系統 SHALL 提供一個可重複執行的統計腳本，掃描本機 Claude 與 Codex 的存量會話，計算沒有專用設定、會以通用卡片或原始 JSON 顯示的工具呼叫比例（MCP 工具另計）。本變更完成時，該比例 MUST 符合：Codex 低於 5%、Claude 低於 1%。

#### Scenario: 驗收統計
- **WHEN** 在變更完成後對同一批存量會話執行統計腳本
- **THEN** Codex 未覆蓋比例低於 5%、Claude 低於 1%，並輸出仍未覆蓋的工具名與次數

### Requirement: 未知工具以通用摘要卡片降級
系統 SHALL 對沒有專用設定的工具顯示可摺疊的摘要卡片：標題為工具名；次要文字取 `title`、`command`、`query`、`path`、`server` 中第一個存在的字串值；原始輸入 MUST 預設收合，展開後才顯示。降級邏輯 MUST NOT 依 provider 分支。

#### Scenario: 新出現的工具
- **WHEN** 任一 provider 送出一個前端沒有設定的工具，輸入為 `{ "path": "/a/b.ts", "extra": 1 }`
- **THEN** 聊天頁顯示標題為該工具名、次要文字為 `/a/b.ts` 的收合卡片，展開後可看到完整輸入

#### Scenario: 輸入不是物件
- **WHEN** 未知工具的輸入是字串或為空
- **THEN** 卡片只顯示工具名，不拋出錯誤

### Requirement: Antigravity 即時與歷史渲染一致
系統 SHALL 讓 Antigravity 的即時事件與歷史 transcript 經過同一套映射產出工具訊息。同一個工具呼叫在對話中與重新載入後，MUST 有相同的 `toolName`、相同形狀的 `toolInput` 與相同格式的 `toolId`。

#### Scenario: 指令執行
- **WHEN** Antigravity 執行 `run_command` 工具
- **THEN** 對話中與重新載入後都以 `Bash` 的單行指令形式渲染，顯示執行的指令

#### Scenario: 可辨識的檔案與搜尋工具
- **WHEN** Antigravity 執行一個在映射表中登記為讀檔、寫檔、改檔或搜尋的工具
- **THEN** 聊天頁分別以 `Read`、`Write`、`Edit`、`Grep`/`Glob` 的形式渲染，而非原始 JSON

#### Scenario: 未登記的工具
- **WHEN** Antigravity 執行一個映射表沒有登記的工具
- **THEN** 保留原工具名，以通用摘要卡片渲染

### Requirement: Antigravity 工具錯誤正確傳遞
系統 SHALL 在 Antigravity 工具結果帶有錯誤資訊時，把工具結果標為錯誤；MUST NOT 對所有結果固定標為成功。若 CLI 的輸出沒有可辨識的錯誤欄位，系統 MUST 在映射模組中註明此限制。

#### Scenario: 指令失敗
- **WHEN** Antigravity 執行的指令以非零結束碼結束，且結果中帶有可辨識的錯誤資訊
- **THEN** 工具卡片顯示為錯誤狀態

### Requirement: 對話流內不得依 provider 分支
聊天訊息與工具卡片的前端渲染元件（`src/components/chat/tools/` 與訊息元件）MUST NOT 以 `provider === '<id>'` 判斷渲染方式。provider 之間的差異 MUST 在後端映射中處理；provider 專屬的功能 MUST 放在對話流外，並由 provider 資訊表決定是否顯示。

#### Scenario: 某家新增工具
- **WHEN** 某個 provider 開始輸出一種新工具，需要專用渲染
- **THEN** 修改的是該 provider 的後端映射（映射到既有標準形狀），或在 spec 中新增一個跨 provider 的標準形狀；不得在前端渲染元件中加入該 provider 的判斷

#### Scenario: 程式碼檢查
- **WHEN** 檢查 `src/components/chat/tools/` 目錄
- **THEN** 其中沒有任何 `provider ===` 判斷
