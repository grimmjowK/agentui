## ADDED Requirements

### Requirement: 搜尋內容由 provider 提供
系統 SHALL 由各 provider 的 sessions facet 負責從該 provider 的會話檔案中提取可搜尋的訊息。全文檢索服務 MUST 依「有實作提取方法的 provider」動態決定搜尋範圍，MUST NOT 寫死 provider 清單。

#### Scenario: 搜尋範圍隨實作決定
- **WHEN** 某個 provider 的 facet 實作了提取方法
- **THEN** 不需修改全文檢索服務，該 provider 的會話就會出現在搜尋結果中

### Requirement: Antigravity 會話可被搜尋
系統 SHALL 支援搜尋 Antigravity 會話中使用者與助手的文字訊息。

#### Scenario: 搜尋 Antigravity 對話內容
- **WHEN** 使用者搜尋一段只出現在某個 Antigravity 會話中的文字
- **THEN** 搜尋結果包含該會話，provider 標示為 `antigravity`，並附上高亮片段

### Requirement: Claude 與 Codex 搜尋行為不回歸
系統 SHALL 在提取職責搬移後，對 Claude 與 Codex 會話維持與搬移前相同的命中結果與片段。

#### Scenario: 既有搜尋結果不變
- **WHEN** 以同一組關鍵字、同一批 Claude 與 Codex 會話，分別在搬移前後執行搜尋
- **THEN** 命中的會話集合與片段內容相同

### Requirement: 不可搜尋的 provider 明確告知
系統 SHALL 在搜尋回應中以 `unsearchableProviders` 列出已註冊但未實作提取方法的 provider；前端 MUST 在搜尋結果區顯示這些 provider 的會話不在搜尋範圍內。

#### Scenario: cursor 尚未支援
- **WHEN** cursor 的 facet 沒有實作提取方法，使用者執行一次搜尋
- **THEN** 搜尋回應的 `unsearchableProviders` 包含 `cursor`，前端顯示提示文字
