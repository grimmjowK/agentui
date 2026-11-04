## ADDED Requirements

### Requirement: 專案清單按 provider 分組
系統 SHALL 在專案清單 API 回應中以 `sessionsByProvider` 欄位提供會話，鍵為已註冊的 provider id；MUST NOT 再提供 `sessions`、`cursorSessions`、`codexSessions`、`geminiSessions`、`antigravitySessions` 等按 provider 寫死的欄位。組裝邏輯 MUST 依 provider registry 動態產生，不得列舉具體的 provider 名稱。

#### Scenario: 回應結構
- **WHEN** 前端請求專案清單
- **THEN** 每個專案帶有 `sessionsByProvider`，其鍵只包含 registry 中已註冊、且在該專案下有會話的 provider

#### Scenario: 新增 provider 不需改動專案模組
- **WHEN** registry 新註冊一個 provider
- **THEN** 不需修改 `server/modules/projects/` 底下的任何檔案，它的會話就會出現在 `sessionsByProvider` 中

### Requirement: 每個 provider 獨立的掃描游標
系統 SHALL 為每個 provider 各自保存並推進會話同步的掃描游標。單一 provider 同步失敗 MUST 只讓該 provider 的游標停止前進，不影響其他 provider。同步服務 MUST NOT 針對特定 provider id 寫特判分支。

#### Scenario: 一個 provider 失敗
- **WHEN** 一次全量同步中 cursor 同步拋出錯誤，其他 provider 成功
- **THEN** 其他 provider 的游標前進到本次掃描邊界，cursor 的游標維持原值，並記錄失敗原因

#### Scenario: 從舊版升級
- **WHEN** 系統首次以新版本啟動，資料庫中只有全域 `scan_state.last_scanned_at` 與 `antigravity_last_scanned_at`
- **THEN** 每個 provider 的初始游標取全域值，antigravity 取它原有的值，不會觸發全量重新掃描

### Requirement: 會話 watcher 輪詢可設定
系統 SHALL 允許以環境變數設定會話 watcher 是否輪詢及輪詢間隔；未設定時 MUST 維持現有行為（輪詢、間隔 6000 毫秒）。

#### Scenario: 預設值
- **WHEN** 未設定 `SESSIONS_WATCHER_POLLING` 與 `SESSIONS_WATCHER_INTERVAL_MS`
- **THEN** watcher 以輪詢模式、間隔 6000 毫秒運作

#### Scenario: 關閉輪詢
- **WHEN** `SESSIONS_WATCHER_POLLING=false`
- **THEN** watcher 改用原生檔案事件，不再輪詢

### Requirement: 未知 provider 資料不得導致崩潰
系統 SHALL 在讀取到未註冊 provider 的資料（例如舊版留下的索引列或收藏紀錄）時略過該筆並記錄警告，MUST NOT 拋出未處理的例外或讓清單載入失敗。

#### Scenario: 殘留的 gemini 收藏
- **WHEN** 收藏紀錄中有一筆 provider 為 `gemini` 的會話
- **THEN** 專案清單正常載入，該筆不出現在清單中，伺服器日誌記錄一則警告
