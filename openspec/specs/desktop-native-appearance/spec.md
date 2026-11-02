# Desktop Native Appearance

## Purpose

定義桌面外殼（Electron）的原生外觀與交互契約：一體化標題欄與拖拽區、原生材質及退回策略、主題同步至原生外殼、桌面專屬交互樣式（不影響瀏覽器端）、原生應用菜單與右鍵菜單、窗口狀態持久化與無閃屏啟動。

## Requirements

### Requirement: 桌面模式標記且不影響瀏覽器端
桌面外殼 SHALL 在頁面 `<html>` 元素上寫入 `data-desktop="<platform>"`（`darwin` / `win32`）。所有桌面專屬樣式與行為 MUST 以該屬性為作用域；未設置該屬性的環境（瀏覽器、PWA、移動端）MUST 與本 change 之前的渲染結果一致。寫入屬性的邏輯 MUST NOT 依賴根元素在 preload 執行時已存在，且其失敗 MUST NOT 阻斷 preload bridge 的暴露。

#### Scenario: 桌面窗口載入應用
- **WHEN** Electron 窗口載入 `http://127.0.0.1:<port>`
- **THEN** `document.documentElement.dataset.desktop` 等於 `process.platform`，且在 React 首次渲染前已存在

#### Scenario: 啟動頁同樣帶標記
- **WHEN** Electron 窗口載入本地啟動頁 `startup.html`
- **THEN** `<html>` 同樣帶 `data-desktop`，啟動狀態 / 重試等既有 bridge API 正常可用

#### Scenario: 瀏覽器直接訪問
- **WHEN** 使用者在瀏覽器中打開同一個後端地址
- **THEN** `<html>` 上不存在 `data-desktop`，頁面不出現拖拽條、游標與選中行為保持原樣

### Requirement: 一體化標題欄與拖拽區
桌面窗口 SHALL 隱藏系統標題欄並把窗口控制按鈕融入頁面：macOS 使用 `hiddenInset` 紅綠燈，Windows 使用 `titleBarOverlay`。頁面頂部 MUST 存在一條全寬拖拽區，其高度與窗口控制按鈕區對齊。拖拽區與其讓位 MUST 在全域層實現，對所有畫面生效（驗證載入、首次設定、登入、onboarding、主畫面、全屏彈窗），不依賴特定 React 組件。頁面可交互內容 MUST 位於拖拽區之外。

#### Scenario: 拖動窗口
- **WHEN** 使用者在頂部拖拽區按住並拖動
- **THEN** 窗口隨之移動

#### Scenario: 雙擊標題區
- **WHEN** 使用者在 macOS 拖拽區雙擊
- **THEN** 窗口按系統偏好設置執行縮放或最小化

#### Scenario: 登入與 onboarding 畫面
- **WHEN** 桌面窗口顯示驗證載入、首次設定、登入或 onboarding 畫面
- **THEN** 頂部同樣存在拖拽區，頁面內容從拖拽區下緣開始，且不因讓位出現多餘的垂直滾動條

#### Scenario: 打開全屏彈窗
- **WHEN** 使用者打開設置窗或其他 `fixed inset-0` 彈窗
- **THEN** 彈窗與遮罩從拖拽區下緣開始，拖拽區仍可拖動窗口，彈窗內任何控件都不在拖拽區內

#### Scenario: 窗口控制按鈕不遮擋內容
- **WHEN** 窗口處於非全屏狀態，無論側邊欄展開或收起
- **THEN** 任何可交互內容都不與 macOS 紅綠燈或 Windows 控制按鈕重疊

#### Scenario: 進入全屏
- **WHEN** 窗口進入全屏
- **THEN** `<html>` 帶上 `data-fullscreen`，拖拽條收起，內容頂到窗口頂部；退出全屏後恢復

#### Scenario: 全屏中換頁
- **WHEN** 窗口處於全屏狀態時，頁面重新整理、從啟動頁導航到應用頁，或後端崩潰後回到啟動頁
- **THEN** 新頁面載入後即帶有 `data-fullscreen`，不出現多餘的拖拽條空白

### Requirement: 原生材質及退回
在支援的系統上，桌面窗口 SHALL 使用原生半透明材質：macOS 作用於側邊欄與拖拽條區域（`vibrancy`），Windows 11 22H2（build 22621）及以上作用於窗口背景（`mica`）。主內容區 MUST 保持不透明。不支援的系統（Windows 10、Windows 11 21H2 等）MUST 不設置材質並使用不透明背景，且任何情況下不得出現整窗透明。

#### Scenario: macOS 側邊欄
- **WHEN** 在 macOS 上打開應用，側邊欄展開或收起
- **THEN** 側邊欄與拖拽條可見地透出桌面材質，主內容區保持不透明背景

#### Scenario: Windows 11 22H2 及以上
- **WHEN** 在 build ≥ 22621 的 Windows 上打開應用
- **THEN** 側邊欄與標題條透出 mica 材質，Windows 控制按鈕背景與之一致無色塊，主內容區保持不透明

#### Scenario: 不支援 mica 的 Windows
- **WHEN** 在 Windows 10 或 Windows 11 21H2 上打開應用
- **THEN** `<html>` 上不存在 `data-material`，窗口使用與主題一致的不透明背景色

#### Scenario: 系統關閉透明效果
- **WHEN** 使用者在系統設置中關閉透明效果（macOS「減少透明度」或 Windows「透明效果」）
- **THEN** 側邊欄與標題條顯示為系統提供的不透明底色，不出現整窗透明

### Requirement: 主題同步至原生外殼
前端 SHALL 是主題的唯一真相；前端主題變化時 MUST 通知 main 進程，main 進程 MUST 同步 `nativeTheme.themeSource`、窗口背景色與 Windows 標題欄 overlay 的顏色，並持久化最後一次主題。冷啟動時 main MUST 在建窗前套用持久化主題；首次啟動（無持久化主題）時 MUST 跟隨系統主題。本 requirement 不要求應用在運行中持續跟隨系統主題變化。

#### Scenario: 應用內切換主題
- **WHEN** 使用者在設置中把深色切到淺色
- **THEN** 原生菜單、右鍵菜單、Windows 窗口控制按鈕、窗口背景都切換為淺色，過程中不出現明顯的異色閃爍或色塊殘留

#### Scenario: 重啟沿用上次主題
- **WHEN** 使用者選擇淺色後退出，在深色系統下重新打開應用
- **THEN** 從窗口出現、啟動頁到應用頁面全程為淺色，不出現深色閃屏

#### Scenario: 首次啟動
- **WHEN** 系統為淺色模式且應用從未啟動過，冷啟動應用
- **THEN** 從窗口出現、啟動頁到應用頁面全程為淺色，不出現深色閃屏

### Requirement: 桌面交互樣式
桌面模式下 UI SHALL 呈現原生應用的交互習慣：按鈕等控件（含帶 `cursor-pointer` 類名的元素）使用預設箭頭游標，外部鏈接保留手型；UI chrome（側邊欄、標題欄、標籤頁、按鈕）不可被選中文本；圖片與鏈接不可被拖出窗口；鍵盤焦點使用 `:focus-visible` 焦點環；禁用觸控板雙指縮放。聊天內容、代碼、終端、輸入框 MUST 保持可選中與可複製。

#### Scenario: 點擊側邊欄
- **WHEN** 使用者在側邊欄連續快速點擊或拖選
- **THEN** 不出現藍色文本選中高亮

#### Scenario: 懸停控件
- **WHEN** 使用者把滑鼠懸停在按鈕或帶 `cursor-pointer` 的元素上
- **THEN** 游標為預設箭頭；懸停在外部鏈接上時為手型

#### Scenario: 選中聊天內容
- **WHEN** 使用者拖選一段助手回覆或代碼塊
- **THEN** 文本可被選中並用 Cmd/Ctrl+C 複製

#### Scenario: 雙指縮放
- **WHEN** 使用者在觸控板上雙指捏合
- **THEN** 頁面不發生縮放；Cmd/Ctrl +/- 仍可縮放

### Requirement: 原生應用菜單與右鍵菜單
桌面外殼 SHALL 設置顯式的應用菜單，至少包含 Edit（撤銷/重做/剪切/複製/貼上/全選）、View（重新載入、實際大小/放大/縮小、全屏、開發者工具僅在未打包時）、Window 標準角色。在可編輯元素或選中文本上右鍵時 MUST 彈出原生右鍵菜單，提供與上下文匹配的編輯項及拼寫建議。

#### Scenario: 輸入框右鍵
- **WHEN** 使用者在聊天輸入框內右鍵
- **THEN** 彈出原生菜單，包含剪切、複製、貼上、全選，不可用項置灰

#### Scenario: 拼寫錯誤
- **WHEN** 使用者在拼錯的單詞上右鍵
- **THEN** 菜單頂部列出拼寫建議，點擊即替換

#### Scenario: 非編輯區右鍵
- **WHEN** 使用者在沒有選中文本的非可編輯區域右鍵
- **THEN** 不彈出菜單，頁面自身的右鍵處理（如有）不受影響

### Requirement: 窗口狀態持久化與無閃屏顯示
桌面窗口 SHALL 在首幀繪製完成後才顯示，並記住上次的位置、尺寸與最大化狀態。恢復的位置 MUST 落在當前可用顯示器範圍內，否則回到預設居中尺寸。窗口最小寬度 MUST 保證在 100% 頁面縮放下不落入前端移動端佈局；使用者主動放大頁面時允許響應式切換到移動端佈局。

#### Scenario: 重啟恢復窗口
- **WHEN** 使用者調整窗口大小位置後退出並重新打開
- **THEN** 窗口出現在上次的位置與尺寸

#### Scenario: 外接顯示器已拔除
- **WHEN** 上次窗口位於已斷開的外接顯示器
- **THEN** 窗口以預設尺寸出現在主顯示器中央

#### Scenario: 縮到最小寬度
- **WHEN** 頁面縮放為 100% 時，使用者把窗口拖到最窄
- **THEN** 前端仍為桌面佈局（側邊欄常駐），不切換到移動端抽屜佈局
