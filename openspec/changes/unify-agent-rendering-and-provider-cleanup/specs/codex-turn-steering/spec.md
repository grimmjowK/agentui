## ADDED Requirements

### Requirement: Codex 執行中追加指令
系統 SHALL 允許使用者在 Codex 一輪尚在執行時送出追加指令；後端 MUST 透過 app-server 的 `turn/steer` 送到目前的 turn，且 MUST NOT 中斷這一輪。

#### Scenario: 執行中插話成功
- **WHEN** Codex 正在執行某一輪，使用者在輸入框送出「改用 pnpm」
- **THEN** 後端以目前的 `turnId` 作為 `expectedTurnId` 呼叫 `turn/steer`，這一輪繼續執行，對話流中出現一則使用者訊息「改用 pnpm」

### Requirement: 插話的前置條件
系統 SHALL 只在以下條件全部成立時送出 `turn/steer`：該會話有作用中的 Codex run、呼叫者與 run 的擁有者是同一個使用者、run 尚未結束或中斷、目前的 `turnId` 已存在。任一條件不成立時，系統 MUST 回傳拒絕訊息給呼叫者，且 MUST NOT 呼叫 app-server。

#### Scenario: turn 尚未開始
- **WHEN** 使用者在 `turn/start` 回應之前送出插話
- **THEN** 後端回傳 `steer-rejected`，不呼叫 `turn/steer`

#### Scenario: 其他使用者的會話
- **WHEN** 使用者 A 對使用者 B 正在執行的 Codex 會話送出插話
- **THEN** 後端回傳 `steer-rejected`，B 的 run 不受影響

#### Scenario: 已按中斷
- **WHEN** 使用者已按下中斷但這一輪尚未結束，接著送出插話
- **THEN** 後端回傳 `steer-rejected`

### Requirement: 插話內容在重新載入後保留
系統 SHALL 在重新載入 Codex 會話後，於原本的時間位置顯示插話內容。實作前 MUST 先以真實 rollout 確認 `turn/steer` 的輸入是否寫入 rollout 及其條目形狀；若 rollout 不記錄插話，本能力 MUST NOT 開放（資訊表中 codex 的 `midTurnSteer` 維持 `false`），直到找到可靠的持久化來源。

#### Scenario: 重新載入後仍看得到插話
- **WHEN** 使用者在 Codex 執行中插話「改用 pnpm」，這一輪結束後重新整理頁面
- **THEN** 歷史中「改用 pnpm」以使用者訊息出現在插話當時的位置，與重新整理前一致

### Requirement: 插話失敗不影響這一輪
系統 SHALL 在 `turn/steer` 回傳錯誤時只回傳拒絕訊息給前端；MUST NOT 讓這一輪失敗或關閉 app-server。前端 MUST 保留使用者輸入的文字，讓使用者可以重送。

#### Scenario: app-server 拒絕插話
- **WHEN** `turn/steer` 回傳 `expectedTurnId` 不符的錯誤
- **THEN** 這一輪繼續執行，前端顯示插話失敗的提示，輸入框仍保留原文字

### Requirement: Codex 協議型別來自 CLI 生成
系統 SHALL 以 `codex app-server generate-ts` 生成的型別描述 app-server 的請求、回應與通知，並將生成結果提交進版控，檔頭 MUST 記錄生成時的 codex 版本。Codex 介接層 MUST 使用這些型別。

#### Scenario: 協議欄位改名
- **WHEN** 重新生成型別後，某個已使用的欄位被改名或移除
- **THEN** `npm run typecheck` 在 Codex 介接層報錯
