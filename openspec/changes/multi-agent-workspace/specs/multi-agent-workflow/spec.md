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

### Requirement: 第一版工作流禁用工具
工作流節點 SHALL 使用 `toolPolicy: none`，不得繼承 provider 的預設工具權限；此版只處理輸入文字。後端 SHALL 在啟動前驗證 `supportsNoTools`；該能力必須由 adapter 原生工具禁用機制與整合測試證明，覆蓋內建工具、MCP 與子 agent 工具。

#### Scenario: Provider 無法完整禁用工具
- **WHEN** 任一節點的 provider 不支援禁用全部工具
- **THEN** 開始請求回傳 tools_disabled_unsupported，沒有節點開始執行，UI 顯示不支援原因

#### Scenario: 停止後收到遲到完成事件
- **WHEN** run 停止後仍收到節點 complete 事件
- **THEN** 已停止狀態不被改寫，不啟動下游，依 runtime emitsTerminal 契約只產生一次終止結果
