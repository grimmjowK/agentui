## ADDED Requirements

### Requirement: Provider 資訊表
系統 SHALL 在客戶端與服務端共用的位置維護一份 provider 資訊表，型別 MUST 為以 `LLMProvider` 為鍵的完整對應。資訊表 MUST 只包含目前已實作且前端實際使用的欄位：能力（`midTurnSteer`、`images`、`effort`、`artifacts`）、可用權限模式、預設權限模式，以及權限模式映射。

#### Scenario: 能力值
- **WHEN** 讀取資訊表
- **THEN** 只有 `codex` 的 `midTurnSteer` 可為 `true`，且僅在插話持久化驗證通過後才設為 `true`；只有 `antigravity` 的 `artifacts` 可為 `true`，且僅在產物實測確認後才設為 `true`；`images`、`effort` 的值與目前前端送出時的行為一致

#### Scenario: 型別完整性
- **WHEN** 新增一個 provider id 到 `LLMProvider` 型別但沒有加入資訊表
- **THEN** `npm run typecheck` 報錯

### Requirement: 前端依資訊表決定權限模式
前端 SHALL 依資訊表決定每個 provider 可選的權限模式與預設值；MUST NOT 在 provider 狀態 hook 中以 `provider === '<id>'` 判斷。

#### Scenario: 切換 provider
- **WHEN** 使用者從 Claude 切換到 Antigravity
- **THEN** 權限模式重設為資訊表中 Antigravity 的預設值，與現有行為相同

### Requirement: 前端依資訊表決定插話功能
前端 SHALL 依資訊表決定 provider 執行中能否送出訊息；MUST NOT 以 `provider === '<id>'` 的寫法判斷插話功能。

#### Scenario: 支援插話的 provider 執行中
- **WHEN** 目前 provider 的 `midTurnSteer` 為 `true` 且這一輪正在執行
- **THEN** 輸入框可以送出，送出內容走插話流程

#### Scenario: 不支援插話的 provider 執行中
- **WHEN** 目前 provider 的 `midTurnSteer` 為 `false` 且這一輪正在執行
- **THEN** 輸入框的送出按鈕維持停用，與現有行為相同
