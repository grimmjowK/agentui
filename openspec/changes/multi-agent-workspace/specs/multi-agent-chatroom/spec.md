## ADDED Requirements

### Requirement: 群聊頁面
已建立的聊天室頁面 SHALL 呈現類似一般聊天 App 的群聊介面：使用者訊息靠右，成員訊息靠左並顯示成員頭像、名稱與模型；成員回覆 SHALL 串流顯示。訊息 SHALL 持久化，重新進入時還原。

#### Scenario: 還原歷史
- **WHEN** 使用者重新打開一個已有對話的聊天室
- **THEN** 依序顯示既有訊息，最新訊息在底部

### Requirement: 成員側欄
右側欄 SHALL 列出所有成員（頭像、名稱、角色人設摘要、provider 與模型），並 SHALL 允許切換成員模型與編輯人設。側欄在窄螢幕 SHALL 可收合。

#### Scenario: 切換成員模型
- **WHEN** 使用者在成員側欄將「審稿人」的模型改為另一個模型
- **THEN** 清除該成員舊 session 與紀錄游標，下一次以新模型建立 session 並重播有上限的已保存群聊；同 provider 切換模型也適用

### Requirement: @ 角色與 @ 所有人
輸入框 SHALL 在輸入 `@` 時彈出成員候選（含「所有人」）。送出時：@ 指定成員則只有被 @ 的成員依序回覆；@所有人則所有成員依序回覆；未 @ 任何人時依群聊設定的預設行為處理（預設為所有人）。

#### Scenario: @ 單一角色
- **WHEN** 使用者送出「@產品經理 評估這個需求」
- **THEN** 只有「產品經理」回覆

#### Scenario: @ 所有人
- **WHEN** 使用者送出「@所有人 各自給意見」且聊天室有 3 位成員
- **THEN** 3 位成員依成員順序各回覆一次

#### Scenario: 停止本輪
- **WHEN** 成員回覆進行中使用者點擊「停止」
- **THEN** 目前回覆中止，佇列中尚未發言的成員不再回覆

### Requirement: 群聊規則設定
右側欄 SHALL 提供群聊設定：群規文字、每則回覆最大字數（預設 800）、是否允許 AI 互相 @（預設關閉）、每輪使用者訊息最多觸發的 AI 回覆數（預設等於成員數）、未 @ 時的預設行為。群規文字 SHALL 注入每位成員的提示；數值限制 SHALL 由後端強制執行。

#### Scenario: 超出字數
- **WHEN** 成員回覆超過最大字數
- **THEN** 後端在串流階段限長（含「…」不超過上限），立即取消生成，保存一次 finish_reason=length 的截斷回覆；確認 runtime 終止後才讓下一位發言，並清除被截斷成員的 session

#### Scenario: AI 互相 @ 達上限
- **WHEN** 允許 AI 互相 @ 且本輪 AI 回覆數達到上限
- **THEN** 不再觸發任何成員回覆，並插入系統訊息「已達本輪發言上限」

#### Scenario: 禁止 AI 互相 @
- **WHEN** 允許 AI 互相 @ 為關閉，且某成員回覆中 @ 了其他成員
- **THEN** 被 @ 的成員不會因此發言

### Requirement: 成員純對話執行
聊天室成員 SHALL 以 `toolPolicy: none` 執行，後端 SHALL 先驗證 adapter 的 `supportsNoTools`。全部內建讀寫工具、命令、MCP 與子 agent 工具均須在執行前禁用；提示詞、plan 或唯讀模式不視為禁用工具。不支援時 SHALL 回傳 tools_disabled_unsupported，且不啟動回合。

#### Scenario: 成員嘗試使用工具
- **WHEN** 成員模型嘗試呼叫寫檔工具
- **THEN** 工具呼叫被拒絕，成員只以文字回覆

#### Scenario: Provider 無法禁用工具
- **WHEN** 目標成員 provider 未通過禁用工具能力驗證
- **THEN** 後端拒絕送出、不保存使用者訊息或啟動模型，UI 說明不支援原因

### Requirement: 回合隔離與事件識別
每個聊天室 SHALL 最多有一個 running/stopping 回合，以資料庫約束與交易保證；忙碌時新的送出與定義／群規修改 SHALL 回傳 409，不保存訊息或排隊。送出 SHALL 帶 clientRequestId，同聊天室重試相同識別 SHALL 回傳原 turn。事件 SHALL 包含 multiAgentId、turnId、messageId、memberId、eventSeq；只發給擁有者，前端 SHALL 按識別過濾、去重並以 final 完整內容為準。

#### Scenario: 兩個分頁同時送出
- **WHEN** 同一聊天室收到兩個不同 clientRequestId 的並行請求
- **THEN** 僅一個請求建立回合與訊息，另一個回傳 409，不並行 resume 同一成員 session

#### Scenario: 同一成員多次發言與跨聊天室串流
- **WHEN** 同名或同 id 成員出現在兩個聊天室，或一輪中同一成員回覆兩次
- **THEN** 前端依聊天室、回合與訊息識別將串流送入正確訊息，不混合輸出

#### Scenario: 重連
- **WHEN** 使用者在成員串流時重新連線
- **THEN** GET 還原已保存訊息、活動回合及部分內容快照，補取事件缺口，重複事件不重複追加

### Requirement: 回合停止與復原
停止 SHALL 帶 turnId 且冪等；後端先標記 stopping 並清空佇列，取消目前 runtime，確認終止後才標記 stopped 並接受新回合。停止後 SHALL 忽略遲到輸出與 AI mentions。無法確認終止 SHALL 維持 stopping。重啟 SHALL 將活動回合標記 interrupted 並清除 session 游標，不續跑。刪除 SHALL 先停止回合，再級聯刪除。

#### Scenario: 舊停止請求晚到
- **WHEN** 舊回合已終止且新回合已開始，後端再次收到舊 turnId 的停止請求
- **THEN** 新回合不受影響

#### Scenario: 重啟中斷
- **WHEN** 服務在成員發言途中重啟
- **THEN** 原回合顯示 interrupted，不再調度其佇列；下一次送出建立新 session

### Requirement: 成員 session 與歷史一致
後端 SHALL 在定義外持久化各成員的 provider/model/sessionId、設定指紋與 last_delivered_seq；完整成功後才更新游標。續接 SHALL 只傳入增量紀錄；首次或重建 SHALL 重播最近 50 則、最多 20,000 Unicode code points 並標記截斷。模型、provider、人設、群規、工具政策變更，或發生取消、截斷、錯誤、resume 失敗時 SHALL 清除相關 session，從已保存群聊重建。歷史訊息 SHALL 保存發言當時的名稱/provider/model。

#### Scenario: 更換 provider 或人設
- **WHEN** 使用者在回合結束後更換成員 provider 或人設
- **THEN** 下一輪使用新設定與新 session，不向新 provider 傳入舊 sessionId，歷史訊息仍顯示原發言者設定

### Requirement: 生成限制與費用提示
最大字數 SHALL 為 1–8,000 的整數（預設 800，按 Unicode code points 計且包含截斷標記）；回覆次數 SHALL 為 1–32 的整數（預設成員數），失敗與截斷嘗試也計入。每位成員 SHALL 從啟動起有 120 秒期限，支援原生輸出 token 預算時額外設為 4,096。達限或超時 SHALL 取消 runtime 並等待終止；UI SHALL 說明這些不是精確費用上限。只有完整成功且未截斷的回覆可觸發 AI mentions。

#### Scenario: 持續推理但沒有輸出文字
- **WHEN** 成員執行達 120 秒仍未完成
- **THEN** 後端取消 runtime、保存超時狀態、清除該 session；確認終止後才繼續其餘成員，該嘗試計入本輪上限

#### Scenario: 非法限制
- **WHEN** 保存的群規含負數、非整數或超出範圍的字數／次數上限
- **THEN** 前後端拒絕保存並回傳具體校驗錯誤
