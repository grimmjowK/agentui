## ADDED Requirements

### Requirement: 產物能力以實測為前提
系統 SHALL 只在實測確認某個 provider 的 CLI 確實會在會話目錄寫出 Markdown 產物後，才把該 provider 的 `capabilities.artifacts` 設為 `true` 並實作產物讀取。實測 MUST 以真實 CLI 執行一次多步驟任務，並把產物清單記錄進 design。若實測發現 CLI 不產出任何產物，本能力 MUST NOT 實作，資訊表中所有 provider 的 `artifacts` 維持 `false`。

#### Scenario: CLI 不產出產物
- **WHEN** 以 Antigravity CLI 執行多步驟任務後，`brain/<sessionId>/` 頂層沒有任何 `.md` 檔案
- **THEN** 不實作產物讀取與面板，資訊表中 `antigravity` 的 `artifacts` 為 `false`，聊天頁不出現 Artifacts 按鈕

### Requirement: 會話產物由 provider sessions facet 提供
系統 SHALL 透過 `IProviderSessions` 的可選方法 `listArtifacts(sessionId)` 讀取會話產物，並透過 `GET /api/providers/sessions/:sessionId/artifacts` 對外提供，與其他以 sessionId 為主的會話路由一致。路由 MUST 依該會話在索引中的 provider 分派，對未實作該方法的 provider 回傳空陣列 `[]`。

#### Scenario: Antigravity 會話產物讀取
- **WHEN** Antigravity 會話的 `brain/<sessionId>/` 目錄下含有實測確認的 `.md` 產物與 `.system_generated/logs/transcript.jsonl`
- **THEN** `listArtifacts` 回傳頂層的 `.md` 產物（含標題、檔名、更新時間與內容），且不包含 `.system_generated` 下的內部紀錄檔

#### Scenario: 未實作產物的 provider
- **WHEN** 前端請求一個未實作 `listArtifacts` 的 provider 會話產物
- **THEN** API 回傳 200 與空陣列 `[]`

### Requirement: 產物讀取不得越出會話目錄
系統 SHALL 在讀取產物前以既有的 `parseSessionId` 規則驗證 `sessionId`，並在解析出實際路徑（含符號連結）後確認仍位於該 provider 的產物根目錄內；任一檢查失敗 MUST 回傳錯誤且不讀取任何檔案。產物讀取 MUST 只回傳 `.md` 檔案。

#### Scenario: 路徑穿越
- **WHEN** 請求的 `sessionId` 為 `../../etc`
- **THEN** API 回傳 400，不讀取任何檔案

#### Scenario: 符號連結指向目錄外
- **WHEN** 會話目錄下有一個 `.md` 符號連結指向產物根目錄以外的檔案
- **THEN** 該檔案不出現在回傳結果中

### Requirement: 對話流外右側 Artifacts 預覽面板
前端 SHALL 依 provider 資訊表的 `capabilities.artifacts` 決定是否在聊天頁工具列顯示「產物（Artifacts）」切換按鈕；開啟時 MUST 在對話流外的右側可收合面板渲染各產物的 Markdown 內容，並在目前會話的一輪對話完成（`complete`）時自動刷新。

#### Scenario: 支援產物的 provider 檢視與刷新
- **WHEN** 使用者開啟 Antigravity 會話並展開右側 Artifacts 面板，隨後這個會話的一輪對話執行完成並更新了產物
- **THEN** 面板自動刷新並呈現最新內容，且對話流內部的訊息渲染不受影響

#### Scenario: 不支援產物的 provider
- **WHEN** 目前 provider 的 `capabilities.artifacts` 為 `false`
- **THEN** 聊天頁工具列不顯示 Artifacts 面板切換按鈕
