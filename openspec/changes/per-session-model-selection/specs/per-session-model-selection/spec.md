## ADDED Requirements

### Requirement: 已有 session 的模型選擇按 session 保存
系統 SHALL 在已有 sessionId 的 session 中切換模型時，只把選擇保存為該 session 的模型記錄，且 MUST NOT 修改 provider 的全域預設模型。

#### Scenario: 在存量 session 中切換模型
- **WHEN** 使用者在 session A 中透過右下角選擇器或 `/model <name>` 把模型切換為 X
- **THEN** session A 的模型記錄變為 X
- **AND** provider 的全域預設模型保持不變

#### Scenario: 切換模型不影響其他 session
- **WHEN** 使用者在 session A 中把模型切為 X，之後打開記錄為模型 Y 的 session B
- **THEN** 選擇器顯示 Y，且在 session B 發送訊息時使用模型 Y

### Requirement: 切換 session 時還原該 session 的模型
系統 SHALL 在選取已有 session 時，把選擇器與發送使用的模型設為該 session 的模型記錄；若無記錄，SHALL 回退為該 provider 的全域預設模型。

#### Scenario: 有記錄的 session
- **WHEN** 使用者打開一個已記錄模型 Y 的 session
- **THEN** 右下角選擇器顯示 Y

#### Scenario: 無記錄的存量 session
- **WHEN** 使用者打開一個沒有模型記錄的 session
- **THEN** 右下角選擇器顯示該 provider 的全域預設模型

### Requirement: 新 session 使用並設定全域預設模型
系統 SHALL 在新 session 畫面（尚無 sessionId）顯示 provider 的全域預設模型；在此畫面切換模型時 SHALL 更新全域預設模型。

#### Scenario: 在新 session 中切換模型
- **WHEN** 使用者在新 session 畫面把模型切換為 X
- **THEN** 全域預設模型變為 X，下一個新 session 預設顯示 X

#### Scenario: 從存量 session 回到新 session
- **WHEN** 使用者在記錄為 Y 的 session 中，之後點擊新建 session
- **THEN** 選擇器顯示全域預設模型，而非 Y

### Requirement: 建立與發送時綁定 session 的模型
系統 SHALL 在新 session 建立（取得 sessionId）時，把首次發送所用的模型寫入該 session 的模型記錄；並 SHALL 在之後每次對該 session 發送訊息時以當下模型更新記錄。

#### Scenario: 只發過一則訊息的新 session
- **WHEN** 使用者在新 session 以模型 Y 發送一則訊息建立 session C（之後不再手動發送），再到新 session 畫面把模型切為 X，然後打開 session C
- **THEN** 選擇器顯示 Y，而非 X

#### Scenario: 新 session 建立後綁定模型
- **WHEN** 使用者在新 session 中以模型 X 建立 session C，之後在新 session 畫面把全域預設改為 Z
- **THEN** 重新打開 session C 時選擇器顯示 X，而非 Z

#### Scenario: 存量 session 升級後首次發送
- **WHEN** 一個無記錄的存量 session 以模型 X 發送訊息
- **THEN** 該 session 的模型記錄變為 X

### Requirement: session 模型記錄持久化於後端
系統 SHALL 將 session 的模型記錄保存在後端資料庫，且 MUST NOT 依賴瀏覽器 localStorage，使記錄在 app 重啟、版本升級、桌面端頁面 origin 變動或更換瀏覽器後仍可讀取。

#### Scenario: 桌面端重啟後還原
- **WHEN** 使用者在桌面端以模型 Y 建立 session C，完全結束並重新啟動 app 後打開 session C
- **THEN** 右下角選擇器顯示 Y
