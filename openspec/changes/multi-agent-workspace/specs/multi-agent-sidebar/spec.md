## ADDED Requirements

### Requirement: 側邊欄以「多 Agent」取代「對話」模式
側邊欄頂部模式切換 SHALL 只包含「專案」、「多 Agent」、「封存」三項，不再提供「對話」模式。舊的 `conversations` 偏好值 SHALL 回退為「專案」。

#### Scenario: 顯示新的模式切換
- **WHEN** 使用者打開側邊欄
- **THEN** 模式切換顯示「專案」、「多 Agent」與封存圖示按鈕，沒有「對話」按鈕

#### Scenario: 舊偏好回退
- **WHEN** 本機保存的模式值為 `conversations`
- **THEN** 側邊欄以「專案」模式顯示

### Requirement: 多 Agent 列表
在「多 Agent」模式下，側邊欄 SHALL 列出目前使用者建立的所有聊天室與工作流，每項顯示類型圖示、名稱與最後更新時間，並可由搜尋框依名稱過濾。點擊項目 SHALL 導向 `/multi-agent/:id`。

#### Scenario: 列出聊天室與工作流
- **WHEN** 使用者切換到「多 Agent」模式且已建立 1 個聊天室與 1 個工作流
- **THEN** 列表顯示兩項，分別帶聊天室與工作流圖示，依更新時間倒序

#### Scenario: 空列表
- **WHEN** 使用者尚未建立任何多 Agent
- **THEN** 顯示空狀態說明與底部的建立按鈕

#### Scenario: 名稱過濾
- **WHEN** 使用者在搜尋框輸入「週報」
- **THEN** 列表只顯示名稱包含「週報」的項目

### Requirement: 建立入口與類型選擇
「多 Agent」列表底部 SHALL 固定顯示「+ 建立」按鈕；點擊後 SHALL 顯示「聊天室」與「工作流」兩個選項，選擇後建立草稿並進入建立器頁面。

#### Scenario: 選擇工作流
- **WHEN** 使用者點擊「+ 建立」並選擇「工作流」
- **THEN** 系統建立一筆 kind 為 workflow、定義為空的草稿，並導向該草稿的建立器頁面

#### Scenario: 取消建立
- **WHEN** 使用者打開類型選擇後點擊外部或按 Esc
- **THEN** 選單關閉，不建立任何草稿

### Requirement: 刪除與重新命名
使用者 SHALL 能在列表項目的操作選單中重新命名或刪除多 Agent；刪除 SHALL 需要二次確認，且同時刪除其執行紀錄與群聊訊息。

#### Scenario: 刪除執行中的工作流
- **WHEN** 使用者刪除一個有執行中 run 的工作流並確認
- **THEN** 系統先停止該 run，再刪除工作流與其所有紀錄
