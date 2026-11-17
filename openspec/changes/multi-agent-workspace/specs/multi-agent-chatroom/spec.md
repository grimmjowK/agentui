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
- **THEN** 該成員之後的回覆使用新模型；provider 支援跨模型續接時沿用 session，否則重建 session 並重播有上限的群聊紀錄

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
- **THEN** 後端在串流階段限長（含「…」不超過上限），立即取消生成，保存一次 finish_reason=length 的截斷回覆；確認 runtime 終止後才讓下一位發言，下一輪提示該成員上次回覆被截斷，不清除 session

#### Scenario: AI 互相 @ 達上限
- **WHEN** 允許 AI 互相 @ 且本輪 AI 回覆數達到上限
- **THEN** 不再觸發任何成員回覆，並插入系統訊息「已達本輪發言上限」

#### Scenario: 禁止 AI 互相 @
- **WHEN** 允許 AI 互相 @ 為關閉，且某成員回覆中 @ 了其他成員
- **THEN** 被 @ 的成員不會因此發言

### Requirement: 成員工具權限
聊天室成員 SHALL 預設以該 provider 最保守的現有權限模式執行（Claude/Cursor 為 plan，Codex 與 Antigravity 為 default），並 SHALL 允許在成員設定中調整。審批請求 SHALL 進入全域審批收件匣。四家 provider 都 SHALL 可作為成員。

#### Scenario: 預設權限
- **WHEN** 建立一個 Claude 成員
- **THEN** 該成員以 plan 模式執行

#### Scenario: 成員請求審批
- **WHEN** Codex 成員在 default 模式下請求執行命令
- **THEN** 請求出現在全域審批收件匣，未核准前該成員發言計時暫停

### Requirement: 回合隔離與排隊
每個聊天室 SHALL 同時最多一個 running/stopping 回合。回合進行中使用者送出的訊息 SHALL 被保存並標記為排隊中，不回傳錯誤；本輪結束後 SHALL 依送出順序逐則開啟新回合。使用者 SHALL 能取消尚未開始的排隊訊息。回合期間修改成員或群規 SHALL 照常保存並於下一回合生效。事件 SHALL 帶 multiAgentId、turnId、messageId、memberId，只發給擁有者；前端 SHALL 依識別歸檔串流。

#### Scenario: 忙碌時送出
- **WHEN** 成員正在回覆時使用者送出新訊息
- **THEN** 新訊息顯示為排隊中，本輪結束後自動開始新回合處理它

#### Scenario: 兩個分頁同時送出
- **WHEN** 同一聊天室幾乎同時收到兩則使用者訊息
- **THEN** 兩則都被保存，依順序分屬兩個回合，不並行續接同一成員 session

#### Scenario: 取消排隊訊息
- **WHEN** 使用者取消一則排隊中的訊息
- **THEN** 該訊息被移除，不觸發任何成員回覆

#### Scenario: 跨聊天室串流
- **WHEN** 兩個聊天室同時有成員在串流
- **THEN** 前端依 multiAgentId 與 messageId 將串流送入正確訊息，不混合輸出

#### Scenario: 重連
- **WHEN** 使用者在成員串流時重新連線
- **THEN** 重新取得訊息列表，執行中的訊息顯示目前已累積內容並繼續接收串流

### Requirement: 回合停止與復原
停止 SHALL 帶 turnId，重複呼叫無副作用；後端先標記 stopping 並清空本輪待發言成員，取消目前 runtime，終止後標記 stopped，再處理排隊訊息。停止後 SHALL 忽略遲到輸出與 AI mentions。重啟 SHALL 將活動回合標記 interrupted，不續跑，排隊訊息保留。刪除 SHALL 先停止回合，再級聯刪除。

#### Scenario: 舊停止請求晚到
- **WHEN** 舊回合已終止且新回合已開始，後端再次收到舊 turnId 的停止請求
- **THEN** 新回合不受影響

#### Scenario: 重啟中斷
- **WHEN** 服務在成員發言途中重啟
- **THEN** 原回合顯示 interrupted，不再調度其待發言成員

### Requirement: 成員 session 依變更類型處理
後端 SHALL 在定義外持久化各成員的 provider、model、sessionId 與 last_delivered_seq；完整成功後才更新游標。續接 SHALL 只傳入增量紀錄。session SHALL 只在以下情況重建：更換 provider；同 provider 換模型且 provider 不支援跨模型續接；續接失敗。改人設、名稱、群規 SHALL 不重建，下一輪提示設定已更新；截斷、停止、錯誤、超時 SHALL 不重建。重建時 SHALL 重播最近 50 則、最多 20,000 Unicode code points 並標記截斷。歷史訊息 SHALL 保存發言當時的名稱/provider/model。

#### Scenario: 更換 provider
- **WHEN** 使用者把成員從 Claude 改為 Codex
- **THEN** 下一輪建立新 Codex session 並重播有上限的群聊紀錄，不傳入舊 sessionId，歷史訊息仍顯示原設定

#### Scenario: 修改人設
- **WHEN** 使用者修改成員人設
- **THEN** 下一輪沿用原 session，提示開頭附上設定已更新的說明

#### Scenario: 同 provider 換模型
- **WHEN** 使用者把 Codex 成員換成另一個 Codex 模型
- **THEN** 因 Codex 不支援跨模型續接，下一輪重建 session

#### Scenario: 續接失敗
- **WHEN** 成員 session 續接時 provider 回報錯誤
- **THEN** 清除該 session，以重播紀錄重建後重試一次

### Requirement: 生成限制與費用提示
最大字數 SHALL 為 1–8,000 的整數（預設 800，按 Unicode code points 計且包含截斷標記）；回覆次數 SHALL 為 1–32 的整數（預設成員數），失敗與截斷嘗試也計入。每位成員 SHALL 從啟動起有 120 秒期限（等待審批不計時）。達限或超時 SHALL 取消 runtime 並等待終止；UI SHALL 說明這些不是精確費用上限。只有完整成功且未截斷的回覆可觸發 AI mentions。

#### Scenario: 持續推理但沒有輸出文字
- **WHEN** 成員執行達 120 秒仍未完成
- **THEN** 後端取消 runtime、保存超時狀態，確認終止後才繼續其餘成員，該嘗試計入本輪上限

#### Scenario: 非法限制
- **WHEN** 保存的群規含負數、非整數或超出範圍的字數／次數上限
- **THEN** 前後端拒絕保存並回傳具體校驗錯誤
