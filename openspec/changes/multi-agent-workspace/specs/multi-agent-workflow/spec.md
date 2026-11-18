## ADDED Requirements

### Requirement: 可視化流程圖
已建立的工作流頁面 SHALL 顯示依依賴分層的流程圖：每個節點為卡片（標題、模型徽章、進度條、狀態圖示），依賴以連線表示。畫布 SHALL 可平移以容納超出可視範圍的節點。

#### Scenario: 渲染分層
- **WHEN** 工作流有節點 A、B、C，且 B、C 都依賴 A
- **THEN** A 在第一層，B 與 C 並列在第二層，A 分別連線到 B 與 C

### Requirement: 節點詳情與編輯
點擊節點 SHALL 打開詳情面板，顯示並允許編輯執行內容；模型 SHALL 可點擊後從列表（按 provider 分組）切換。修改 SHALL 立即保存到定義。執行中 SHALL 禁止編輯。

#### Scenario: 切換模型
- **WHEN** 使用者在節點詳情點擊模型並選擇另一個模型
- **THEN** 節點卡片的模型徽章更新，重新整理後仍為新模型

#### Scenario: 執行中禁止編輯
- **WHEN** 工作流正在執行時使用者打開節點詳情
- **THEN** 執行內容與模型為唯讀，並顯示該節點目前的輸出

### Requirement: 執行整個工作流
「開始」按鈕 SHALL 在後端建立一次執行：依賴全部成功的節點才可啟動，同時並行最多 3 個；每個節點的提示 SHALL 包含自身執行內容與上游節點的輸出。開始前 SHALL 顯示將呼叫的節點數量。使用者 SHALL 能停止執行。

#### Scenario: 依序執行
- **WHEN** 使用者對 A→B 工作流點擊「開始」
- **THEN** A 先執行，A 成功後 B 才啟動，且 B 的提示包含 A 的輸出

#### Scenario: 停止執行
- **WHEN** 使用者在執行中點擊「停止」
- **THEN** 所有執行中節點被中止並標記為失敗（已停止），未開始的節點標記為略過

#### Scenario: 關閉頁面後繼續
- **WHEN** 使用者在執行中離開頁面後再回來
- **THEN** 工作流仍在後端執行，頁面還原每個節點的目前狀態

### Requirement: 節點進度與結果標示
每個節點下方 SHALL 顯示進度條（等待、執行中逐步推進、完成時滿格）；成功 SHALL 顯示對號，失敗 SHALL 顯示錯號，失敗節點的下游 SHALL 標示為略過。節點狀態 SHALL 即時透過 WebSocket 更新。

#### Scenario: 節點失敗
- **WHEN** 節點 A 執行失敗
- **THEN** A 顯示錯號與錯誤訊息，依賴 A 的節點顯示為略過，工作流整體狀態為失敗

#### Scenario: 全部成功
- **WHEN** 所有節點執行成功
- **THEN** 每個節點進度條滿格並顯示對號，點擊節點可查看完整輸出

### Requirement: 執行中斷復原
服務重啟時，狀態為執行中的工作流執行 SHALL 被標記為失敗（已中斷），不自動續跑。

#### Scenario: 服務重啟
- **WHEN** 工作流執行中服務重啟
- **THEN** 重啟後該執行的進行中節點顯示為失敗（已中斷），使用者可重新開始

### Requirement: 不可變的執行快照
每個 run SHALL 以交易保存完整定義與版本（包含節點 id、標題、指令、模型、provider、依賴）；調度與歷史詳情 SHALL 依該快照顯示。系統 SHALL 提供執行列表與指定 run 詳情。同一工作流 SHALL 最多一個 running/stopping run。

#### Scenario: 修改或刪除舊節點
- **WHEN** 工作流執行完成後使用者修改模型、刪除節點或重用節點 id
- **THEN** 舊 run 仍顯示當時的節點、指令、模型、依賴與輸出，不套用目前定義

#### Scenario: 重複開始
- **WHEN** 另一分頁在工作流已有 running/stopping run 時要求開始
- **THEN** 後端回傳 409，不建立第二個 run 或呼叫模型

### Requirement: 節點工具權限
工作流節點 SHALL 允許使用工具，並以節點層級的權限模式執行；權限模式選項 SHALL 取自該 provider 支援的模式，預設為 provider 預設模式。需審批的工具請求 SHALL 進入全域審批收件匣，節點顯示「等待審批」。四家 provider 都 SHALL 可用於節點。

#### Scenario: 節點需要審批
- **WHEN** 節點以 default 權限模式執行並請求寫檔
- **THEN** 節點卡片顯示等待審批，使用者在審批收件匣核准後節點繼續執行

#### Scenario: 切換節點權限模式
- **WHEN** 使用者在節點詳情把 Codex 節點的權限模式改為 acceptEdits
- **THEN** 下次執行該節點以 acceptEdits 模式啟動

#### Scenario: 並行節點提示
- **WHEN** 使用者開始一個含同層並行節點的工作流
- **THEN** 確認彈窗提示並行節點共用工作目錄

#### Scenario: 停止後收到遲到完成事件
- **WHEN** run 停止後仍收到節點 complete 事件
- **THEN** 已停止狀態不被改寫，不啟動下游，依 runtime emitsTerminal 契約只產生一次終止結果

### Requirement: 人工確認節點
工作流 SHALL 支援 `type: "approval"` 的人工確認節點（不需 provider / model）。執行到此節點時 SHALL 暫停，節點顯示「等待確認」並自動打開詳情，顯示確認內容與上游輸出；使用者 SHALL 能填寫備註後核准或駁回。核准後節點輸出 SHALL 為上游輸出加上備註並傳給下游；駁回則節點失敗、下游略過。停止執行時等待中的確認節點 SHALL 視為駁回。

#### Scenario: 核准並帶備註
- **WHEN** propose 完成後執行到人工確認節點，使用者填寫「只 apply 18350」並核准
- **THEN** 下游 apply 節點開始執行，其提示包含 propose 的輸出與該備註

#### Scenario: 駁回
- **WHEN** 使用者駁回人工確認節點
- **THEN** 該節點標示失敗（rejected），所有下游節點略過，執行狀態為失敗

#### Scenario: 節點內處理工具審批
- **WHEN** 執行中的節點請求工具審批（含規劃模式的 ExitPlanMode）
- **THEN** 節點顯示等待審批並自動打開詳情，使用者可直接在詳情中允許或拒絕
