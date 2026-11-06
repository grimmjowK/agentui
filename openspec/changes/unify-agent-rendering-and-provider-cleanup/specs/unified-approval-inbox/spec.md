## ADDED Requirements

### Requirement: Claude 審批擁有者綁定
系統 SHALL 在記錄 Claude 待審批工具請求時綁定發起該會話的 `userId`，並在處理 `claude-permission-response` 時驗證呼叫者：待審批有記錄擁有者時，呼叫者的 `userId` MUST 存在且相同；呼叫者缺少 `userId` 或不一致時 MUST 拒絕放行、維持待審批狀態，並回覆一則警告。此規則 MUST 與 Codex `codexApprovals.decide` 的比對方式一致。

#### Scenario: 同一使用者放行審批
- **WHEN** 使用者 A 發起的 Claude 會話產生一筆待審批請求，且使用者 A 送出允許回應
- **THEN** 審批通過，工具繼續執行

#### Scenario: 其他使用者嘗試越權放行
- **WHEN** 使用者 A 發起的 Claude 會話產生一筆待審批請求，而使用者 B 送出針對該 `requestId` 的回應
- **THEN** 後端拒絕該回應並回覆警告，使用者 A 的待審批請求不受影響

#### Scenario: 呼叫者缺少 userId
- **WHEN** 一筆有記錄擁有者的待審批請求，收到一個 `userId` 為空的連線送出的回應
- **THEN** 後端拒絕該回應，待審批請求維持不變

### Requirement: 審批逾時預設 600 秒
系統 SHALL 將 Claude 工具審批的預設逾時設為 600000 毫秒，網頁版、容器部署與桌面版一致；`CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` 有設定時以設定值為準。逾時時 MUST 送出 `permission_cancelled`。

#### Scenario: 網頁版預設逾時
- **WHEN** 網頁版未設定 `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS`，一筆 Claude 審批請求在 5 分鐘時仍未決定
- **THEN** 請求仍為待審批，可以被批准

#### Scenario: 逾時取消
- **WHEN** 一筆 Claude 審批請求超過 600 秒未決定
- **THEN** 請求被取消，前端收到 `permission_cancelled` 並移除對應項目

### Requirement: 跨 provider 與跨會話待審批查詢
系統 SHALL 透過 `IProviderRuntime` 的可選方法 `getPendingApprovals(userId, sessionId?)` 查詢待審批項目，且只回傳屬於該 `userId` 的項目。WebSocket 的 `get-pending-permissions` 訊息在帶 `sessionId` 時 MUST 回傳該會話（跨 provider）的待審批項目；不帶 `sessionId` 時 MUST 匯總該使用者在所有已註冊 provider 與活躍會話中的待審批項目。

#### Scenario: 同時存在 Claude 與 Codex 的待審批請求
- **WHEN** 同一使用者的會話 S1（Claude）與會話 S2（Codex）各自有一筆待審批請求，前端在連線時送出不帶 `sessionId` 的 `get-pending-permissions`
- **THEN** 回應同時包含 S1 與 S2 的待審批請求，各自標明 `provider` 與 `sessionId`

#### Scenario: 不回傳其他使用者的待審批
- **WHEN** 使用者 B 送出不帶 `sessionId` 的 `get-pending-permissions`，而只有使用者 A 有待審批請求
- **THEN** 回應為空陣列

### Requirement: 前端跨會話保留待審批池與側邊欄提示
前端 SHALL 在全域待審批池中保留所有活躍會話的待審批請求；切換會話或切換 provider 時 MUST NOT 清空其他會話的待審批請求。聊天框內的審批橫幅 MUST 只顯示屬於目前選中會話的請求；側邊欄會話列表 MUST 為有待審批請求的會話顯示待審批徽章，並提供收件匣快速跳轉入口。

#### Scenario: 切換到其他會話時保留背景待審批
- **WHEN** 會話 S1 產生一筆待審批請求，使用者切換到會話 S2
- **THEN** S2 的聊天框內不顯示 S1 的審批橫幅，但側邊欄的 S1 會話旁顯示「待審批」徽章，且切回 S1 時審批橫幅立即顯示

#### Scenario: 背景會話完成或取消審批時移除徽章
- **WHEN** 會話 S1 的待審批請求被決議、逾時取消（`permission_cancelled`）或該輪結束（`complete`、`error`）
- **THEN** 全域待審批池移除 S1 對應的項目，側邊欄 S1 的「待審批」徽章隨之消失

### Requirement: 背景會話事件不得改變目前畫面狀態
前端 SHALL 只在事件所屬會話等於目前選中會話時，才因 `permission_request`、`complete`、`error` 等事件改變目前畫面的執行狀態（載入中、可中斷、狀態文字）。背景會話的這些事件 MUST 只更新全域待審批池與側邊欄提示。

#### Scenario: 背景會話請求審批
- **WHEN** 使用者正在看閒置的會話 S2，背景會話 S1 送出 `permission_request`
- **THEN** S2 的畫面不進入載入中、不顯示「Waiting for permission」，只有側邊欄 S1 出現待審批徽章

#### Scenario: 背景會話結束
- **WHEN** 使用者正在看執行中的會話 S2，背景會話 S1 送出 `complete`
- **THEN** S2 仍維持執行中狀態，可以中斷
