## ADDED Requirements

### Requirement: 預設模式下的互動審批
系統 SHALL 以 `agy acp` 執行 Antigravity 對話。CLI 發出 `session/request_permission` 時，系統 MUST 在頁面上顯示審批卡片，並把使用者的決定回覆給 CLI；系統 MUST NOT 在未經使用者決定的情況下自動拒絕（逾時除外）。

#### Scenario: 允許後工具執行
- **WHEN** 使用者在預設模式下請 Antigravity 執行 `ls -la`，頁面出現審批卡片，使用者按下允許
- **THEN** 工具實際執行，工具卡片顯示執行結果，Antigravity 繼續產生回覆，這一輪正常結束

#### Scenario: 拒絕後頁面看得到結果
- **WHEN** 使用者在審批卡片上按下拒絕
- **THEN** CLI 收到拒絕，工具卡片顯示為被拒絕（錯誤狀態），這一輪結束後頁面不停留在「處理中」

#### Scenario: 卡片顯示要執行的內容
- **WHEN** CLI 請求審批執行指令 `ls -la`
- **THEN** 審批卡片顯示映射後的工具名稱與參數（例如 Bash 與 `ls -la`），以及可選的決定與到期時間

### Requirement: 審批項目接入全域待審批池
系統 SHALL 讓 Antigravity 的待審批項目與 Claude、Codex 一樣進入全域待審批池：每個項目綁定發起這一輪的使用者，`get-pending-permissions` MUST 只回傳該使用者的項目。只有發起者能做出決定；其他使用者或缺少使用者身分的決定 MUST 被拒絕且回覆警告。

#### Scenario: 重新整理後仍可審批
- **WHEN** 頁面顯示 Antigravity 審批卡片時使用者重新整理頁面
- **THEN** 側邊欄收件匣與該會話的審批卡片仍在，使用者按下允許後工具照常執行

#### Scenario: 切換會話後從收件匣審批
- **WHEN** Antigravity 會話 A 等待審批時，使用者切到會話 B
- **THEN** 會話 B 不顯示 A 的審批卡片，側邊欄收件匣列出 A；點擊後回到 A 並可完成審批

#### Scenario: 其他使用者無法審批
- **WHEN** 使用者 B 對使用者 A 的待審批項目送出決定
- **THEN** 系統拒絕這個決定並回覆警告，A 的項目仍在等待中

### Requirement: 審批逾時與清除
系統 SHALL 在審批等待超過逾時（預設 10 分鐘）時回覆拒絕給 CLI 並送出 `permission_cancelled`。使用者中斷、CLI 行程結束或這一輪結束時，系統 MUST 清除該輪所有待審批項目並送出 `permission_cancelled`。

#### Scenario: 逾時自動拒絕
- **WHEN** 審批卡片顯示後無人處理直到逾時
- **THEN** CLI 收到拒絕，頁面的審批卡片與收件匣項目消失，這一輪結束

#### Scenario: 中斷時清除待審批
- **WHEN** 頁面顯示審批卡片時使用者按下停止
- **THEN** 系統以 `session/cancel` 中斷這一輪並回覆未決的審批請求為已取消，審批卡片與收件匣項目消失，頁面收到一次中斷完成

### Requirement: 權限模式與 ACP 一致
系統 SHALL 讓 Antigravity 的權限模式選項為 `default`、`acceptEdits`、`plan` 與 `bypassPermissions`。前三者 MUST 以 ACP 的 `session/set_mode` 套用；`bypassPermissions` MUST 只在使用者明確同意後才可作為預設值，啟用時審批請求自動允許、不顯示審批卡片。

#### Scenario: 接受編輯模式
- **WHEN** 使用者選擇 `acceptEdits` 後請 Antigravity 修改工作區內的檔案
- **THEN** 檔案修改不需要審批，執行指令仍需要審批

#### Scenario: 跳過權限模式
- **WHEN** 使用者已明確同意並選擇 `bypassPermissions`，請 Antigravity 執行指令
- **THEN** 指令直接執行，頁面不出現審批卡片

### Requirement: 續接會話
系統 SHALL 以 `session/resume` 續接既有的 Antigravity 會話，MUST NOT 讓 CLI 重播歷史訊息到頁面；續接後的新訊息 MUST 寫入同一個會話的 transcript。

#### Scenario: 在舊會話繼續對話
- **WHEN** 使用者打開一個既有的 Antigravity 會話並送出新訊息
- **THEN** 頁面只出現這一輪的新訊息，舊訊息不重複出現；重新整理後歷史包含先前與這一輪的內容

### Requirement: 錯誤時頁面明確結束
系統 SHALL 在 CLI 未登入、ACP 初始化失敗、協議版本不符或行程意外退出時，送出明確的錯誤訊息並結束這一輪；頁面 MUST NOT 停留在「處理中」。

#### Scenario: CLI 未登入
- **WHEN** Antigravity CLI 尚未登入，使用者送出訊息
- **THEN** 頁面顯示需要先在終端完成 Antigravity 登入的錯誤，這一輪結束

#### Scenario: 行程意外退出
- **WHEN** 這一輪執行中 `agy acp` 行程意外結束
- **THEN** 頁面顯示錯誤，待審批項目被清除，這一輪結束

### Requirement: 執行中插話
Antigravity 的一輪執行中，發起者送出插話時，系統 SHALL 在同一條 ACP 連線上送出新的 `session/prompt`，由 agy 併入目前這一輪；系統 MUST NOT 中斷正在執行的工具，且 MUST 等所有 `session/prompt` 都返回後才結束這一輪並送出一次 `complete`。這一輪已進入收尾或已結束時，插話 MUST 被拒絕並回覆 `not_running`；非發起者的插話 MUST 回覆 `not_owner`。

#### Scenario: 工具執行中插話
- **WHEN** Antigravity 正在執行 `sleep 8`，使用者插話「結尾加上 PINEAPPLE」
- **THEN** 工具照常跑完，最終只產生一則回覆且結尾為 PINEAPPLE，頁面只收到一次 `complete`

#### Scenario: 收尾後的插話被拒
- **WHEN** 這一輪的所有 `session/prompt` 都已返回、行程正在結束時，使用者送出插話
- **THEN** 系統回覆 `steer-rejected`（`not_running`），訊息不會遺失（由前端保留）
