## Context

`desktop-electron-shell` 交付了一個能用的 Electron 外殼：單 `BrowserWindow` 載入 `http://127.0.0.1:<port>`，前端與瀏覽器端完全同一份代碼。為了「前端零改動」，它刻意選了系統標題欄（`electron/main.js` `createWindow` 的註釋），也沒有設置應用菜單、右鍵菜單、窗口狀態持久化；啟動頁固定深色（`#111827`），淺色主題下冷啟動必閃。

現狀與「網頁廉價感」的對應：

| 症狀 | 根因 |
| --- | --- |
| 頂部一條與主題無關的灰色系統標題欄 | 系統標題欄，頁面無法融入 |
| 淺色主題下啟動閃深色 | `backgroundColor` 與啟動頁寫死深色 |
| 按鈕是手型游標、點側邊欄會選中文字、圖片能拖出窗口 | 網頁預設行為，無桌面作用域樣式 |
| 右鍵毫無反應 | Electron 不提供預設右鍵菜單 |
| 每次打開窗口都是 1440×900 | 無窗口狀態持久化 |
| 窗口拖窄後變成移動端抽屜佈局 | `minWidth: 720` < 前端斷點 768（`src/hooks/useDeviceSettings.ts`） |
| 背景是平面色塊 | 未使用 vibrancy / mica |

約束：前端同時服務瀏覽器、PWA、移動端，任何改動都不能影響非桌面環境；`contextIsolation + sandbox` 不能放鬆。

## Goals / Non-Goals

**Goals:**
- 桌面窗口在 macOS / Windows 上看起來和用起來都像原生應用（標題欄、材質、游標、選中、菜單、窗口記憶）。
- 全部桌面樣式掛在 `html[data-desktop]` 作用域下，瀏覽器端行為零變化。
- 前端改動最小：`ThemeContext` 一行通知、`index.css` 一段作用域樣式、`AppContent` 與側邊欄根節點各加鉤子類名。

**Non-Goals:**
- 整體視覺重設計（配色 token、字號密度、組件重繪）—— 屬於設計系統工作，另開 change。
- 把標題欄與 `MainContentHeader` 合併成單層工具列（VS Code 式）—— 本 change 接受「拖拽條 + 既有 header」的雙層頂部結構，見 D2。
- 持續跟隨系統主題 —— 現有前端首次載入即把解析結果寫入 `localStorage`，本來就不持續跟隨系統；本 change 不改這個行為，見 D4。
- 自繪窗口控制按鈕、托盤、Dock 菜單、Touch Bar、Linux。
- 引入新的 npm 依賴（`electron-window-state`、`electron-context-menu` 等）。

## Decisions

### D1：標記方式 —— preload 寫 `html[data-desktop]`，初始狀態快照 + 事件訂閱

preload 與頁面共享 DOM（`contextIsolation` 只隔離 JS 世界），在 preload 裡設置 `<html>` 屬性，CSS 在 React 首次渲染前即可命中。

- 時序：preload 執行時 `document.documentElement` 可能尚未建立。根元素存在則立即寫入；不存在則用 `MutationObserver` 監聽 `document`，在 `<html>` 插入時立即寫入（早於任何頁面腳本執行）。
- bridge（`contextBridge.exposeInMainWorld`）MUST 先於 DOM 初始化完成暴露；DOM 初始化包在 try/catch 裡，失敗不得影響啟動狀態、重試等既有 API。
- 初始狀態：preload 啟動時經一次同步 IPC（`cloudcli:get-desktop-state`）取得 `{ material: boolean, fullscreen: boolean }`，據此寫入 `data-material` / `data-fullscreen`。每次 document 建立（啟動頁 → 應用頁導航、重新整理、後端崩潰回啟動頁）都會重跑 preload，因此狀態不會因換頁丟失。
- 後續變化：main 轉發 `enter-full-screen` / `leave-full-screen`，preload 切換 `data-fullscreen`。與既有啟動狀態 API 同樣是「快照 + 訂閱」模式。

- 備選：前端讀 `window.cloudcliDesktop` 後在 React 裡加 class —— 晚於首幀，且每個組件都要感知桌面模式。否決。
- 備選：只靠全屏事件 —— 全屏中換頁後新 document 拿不到狀態。否決。

### D2：全域拖拽條，而非掛在 `AppContent` 上

`AppContent` 只在登入完成後渲染：`ProtectedRoute` 在驗證載入、首次設定、登入、onboarding 階段直接返回其他畫面（`src/components/auth/view/ProtectedRoute.tsx`）；設置窗等 `fixed inset-0` 彈窗也會覆蓋頁面頂部。因此拖拽條與標題區安全區 MUST 在全域層實現，不依賴任何 React 組件：

- `--titlebar-height`：macOS 38px / Windows 36px（與 overlay 高度一致），`data-fullscreen` 時為 0。
- 拖拽條：`html[data-desktop] body::before`，`position: fixed; top: 0; left: 0; right: 0; height: var(--titlebar-height); -webkit-app-region: drag`，z-index 置於最上層，背景透明（下方透出 `body` 背景或材質）。若實測 Electron 對偽元素拖拽區不生效，退回由 preload 在 `<body>` 下注入一個 `#desktop-titlebar` 節點（在 `#root` 之外，React 不接管），樣式不變。
- 內容讓位，沿用既有 `body.pwa-mode .fixed.inset-0` 的做法：
  - `html[data-desktop] .fixed.inset-0 { top: var(--titlebar-height) }` —— 覆蓋 `AppContent` 根節點、設置窗、命令面板、移動端側邊欄遮罩等所有全屏固定層。
  - `html[data-desktop] #root { padding-top: var(--titlebar-height) }` + `html[data-desktop] .min-h-screen { min-height: calc(100vh - var(--titlebar-height)) }` —— 覆蓋登入、首次設定、onboarding 等文檔流佈局，不出現多餘滾動條。
- 拖拽條內不放任何控件；頁面所有內容都在拖拽條下方，因此不存在 `no-drag` 漏標，也不存在紅綠燈 / Windows 控制按鈕壓住內容的問題（無論側邊欄展開或收起）。
- macOS：`titleBarStyle: 'hiddenInset'`，`trafficLightPosition` 讓紅綠燈垂直居中於拖拽條。
- Windows：`titleBarStyle: 'hidden'` + `titleBarOverlay: { color, symbolColor, height: 36 }`。

代價與接受的結果：
- 垂直方向多 38px，頂部呈「空白拖拽條 + 既有 `MainContentHeader`」雙層結構。這是外殼一體化的第一步，不是工具列重設計；VS Code、Obsidian、Slack 都有全寬標題條。合併成單層工具列屬於 Non-Goal。
- 彈窗遮罩不覆蓋拖拽條（遮罩從拖拽條下緣開始），彈窗打開時仍可拖動窗口，與 macOS sheet 行為一致。
- 非 `.fixed.inset-0` 的頂部固定元素（如 `fixed top-0`）不會自動讓位，實作時需 grep 排查。

- 備選：`AppContent` 根節點 `padding-top` + 偽元素 —— 登入 / onboarding / 彈窗場景失效。否決。
- 備選：`MainContentHeader` 直接當拖拽區 —— 內含可橫向滾動的標籤頁，`drag` 會吞掉滾輪與點擊；且側邊欄收起時紅綠燈仍與它重疊。否決。

### D3：材質 —— macOS `vibrancy: 'sidebar'`，Win11 22H2+ `backgroundMaterial: 'mica'`，CSS 開洞

材質畫在窗口背後，頁面必須透明才能看到：

- 窗口：macOS `vibrancy: 'sidebar'` + `visualEffectState: 'followWindow'`；Windows 僅在 build ≥ 22621（Windows 11 22H2，Electron `setBackgroundMaterial` 的最低支援版本，見 `electron.d.ts`）設置 `backgroundMaterial: 'mica'`，否則不設。
- `data-material` 的語義：**平台支援且 main 已設置材質選項**，經 D1 的同步 IPC 返回。它不代表「OS 確認實際繪製了材質」—— 使用者在系統中關閉透明效果（macOS「減少透明度」、Windows「透明效果」關閉）時，OS 會自行以不透明純色替代材質，頁面仍透明但不會出現整窗透明，這是可接受的降級。
- 頁面（僅 `html[data-desktop][data-material]` 下）：
  - `body` 與 `.app-shell`（`AppContent` 根節點）背景透明，拖拽條透出材質。
  - 側邊欄根節點（`SidebarContent`、`SidebarCollapsed`，加 `.app-sidebar` 鉤子類名）目前是 `bg-background/80 backdrop-blur-sm`：80% 底色會讓材質幾乎看不見，且 CSS blur 在透明窗口上只模糊空白。桌面材質模式下改為 `background-color: hsl(var(--background) / 0.35)`、`backdrop-filter: none`。透明度初值 0.35，以截圖驗收時調整，深 / 淺色可分別取值。
  - `.app-main`（主內容列）保持 `bg-background` 不透明，聊天 / 代碼區可讀性不受影響。
- 未設 `data-material` 時所有區域維持原不透明背景 —— 這就是退回路徑。
- Windows 的 mica 作用於整窗背景，主內容列仍不透明，視覺上只有側邊欄與標題條有 mica，與 macOS 一致。

- 備選：`transparent: true` 自繪毛玻璃（CSS `backdrop-filter`）—— 拿不到桌面背景，只能模糊頁面自身，效果假，且 `transparent` 窗口在 Windows 上禁用縮放 / 最大化相關行為。否決。

### D4：主題同步 —— 前端 → main 單向，前端是唯一真相

現有 `ThemeContext.jsx` 的行為：首次載入時 localStorage 無值則取系統偏好，並立即把結果寫入 `localStorage.theme`；之後系統主題變化的 listener 只在 localStorage 無值時生效，因此實際上**只在首次載入時參考系統偏好**。本 change 不改這個行為，只把前端解析出的主題同步給原生外殼：

- `ThemeContext` 的主題 effect 末尾：`window.cloudcliDesktop?.setTheme(isDarkMode ? 'dark' : 'light')`。
- main 收到後：`nativeTheme.themeSource = theme`（原生菜單 / 右鍵菜單 / 滾動條跟隨）、`win.setBackgroundColor(...)`、Windows 上 `win.setTitleBarOverlay({ color, symbolColor })`（材質啟用時 `color` 用透明）。最後一次主題存進 `window-state.json`。
- 冷啟動：建窗前讀存檔主題，設置 `nativeTheme.themeSource` 與 `backgroundColor`；無存檔（首次啟動）時 `themeSource` 保持 `'system'`，與前端首次載入取系統偏好的行為一致。
- 啟動頁 `startup.html` 改用 `prefers-color-scheme` 兩套變量；因 `themeSource` 已在建窗前設置，啟動頁看到的就是上次主題（或首次啟動時的系統主題）。
- 顏色值取自 `index.css` 的 `--background`（淺 `#ffffff`，深 `hsl(222.2 84% 4.9%)` ≈ `#020817`），在 main 裡寫一份常量並註明出處。
- 切換時序：頁面背景本身有 200ms 顏色過渡（`index.css` 全局 transition），原生外殼經 IPC 更新，兩者不可能同幀。驗收標準是「無明顯的異色閃爍 / 色塊殘留」，而不是同幀。

- 備選：支援 `system / light / dark` 三態並持續跟隨系統 —— 需要改前端主題模型與設置頁 UI，屬於前端主題功能，不屬於外殼原生化。若需要另開 change。

### D5：桌面交互樣式 —— 一段作用域 CSS，而非逐組件改 class

在 `src/index.css` 末尾新增 `@layer base` 段，全部以 `html[data-desktop]` 開頭：

- `button, [role=button], a, summary, label, .cursor-pointer { cursor: default }`（macOS / Windows 原生控件都不用手型游標；外部鏈接 `a[href^="http"]` 保留 pointer）。選擇器特異性高於 Tailwind 的 `.cursor-pointer` 工具類，可覆蓋組件裡的硬編碼；`index.css` 中觸控設備的 `cursor: pointer !important` 只在 `(hover: none) and (pointer: coarse)` 下生效，桌面不受影響。
- `.app-shell { user-select: none }`，再對 `.chat-message, pre, code, .prose, .xterm, .cm-editor, input, textarea, [contenteditable]` 恢復 `user-select: text`。
- `img, a { -webkit-user-drag: none }`。
- `body { -webkit-font-smoothing: antialiased }`（僅 macOS 生效）。
- `:focus:not(:focus-visible) { outline: none }`，`:focus-visible` 用 `--ring`。
- 滾動條：桌面下對全局 `::-webkit-scrollbar` 使用現有 `.scrollbar-thin` 的細樣式。
- 雙指縮放：main 中 `webContents.setVisualZoomLevelLimits(1, 1)`；Cmd/Ctrl +/-/0 保留給 View 菜單的 zoom 角色（這是可訪問性功能，不禁用）。

逐組件把 `cursor-pointer` 改掉是幾十處改動且會影響瀏覽器端；作用域 CSS 一處搞定。

### D6：菜單 —— `Menu.buildFromTemplate` 標準角色 + `context-menu` 事件

- 應用菜單：macOS `appMenu` / `editMenu` / `viewMenu` / `windowMenu` 角色；Windows 用 `fileMenu` / `editMenu` / `viewMenu`。`toggleDevTools` 僅在 `!app.isPackaged` 時加入。菜單文案依賴系統語言（角色自帶本地化），不接 i18next。
- 右鍵：`webContents.on('context-menu', (e, params) => …)`，根據 `params.isEditable`、`params.selectionText`、`params.editFlags`、`params.dictionarySuggestions` 構造菜單；兩者都不滿足時不彈。頁面若自己 `preventDefault` 了 `contextmenu` 事件（例如文件樹自訂菜單），Electron 不會觸發 `context-menu`，自然不衝突。
- 不引入 `electron-context-menu`：需求只是 20 行模板。

### D7：窗口狀態 —— 一個 JSON 文件，不加依賴

- `userData/window-state.json`：`{ x, y, width, height, isMaximized, theme }`，在 `close` 時寫入（`getNormalBounds()` 保證最大化時存的是還原尺寸）。
- 恢復前用 `screen.getAllDisplays()` 檢查矩形是否與某個 `workArea` 相交，不相交則丟棄位置只保留尺寸並居中。
- `show: false`，`ready-to-show` 時 `show()`（若上次最大化則 `maximize()`）。
- `minWidth: 960`（側邊欄 + 最小可用主內容寬度，且 > 768 斷點）。
- 縮放邊界：前端以 CSS 視口寬度 `window.innerWidth < 768` 判斷移動端佈局，頁面縮放會等比縮小 CSS 視口。960px 窗口在約 125% 以上縮放時 CSS 視口 < 768，會切到移動端佈局。**接受此行為**：使用者主動放大時響應式收合是合理的可訪問性結果；`minWidth` 只保證 100% 縮放下不落入移動端佈局。不為此引入桌面專屬的佈局判定。

## Risks / Trade-offs

- [拖拽區吞點擊] → D2 讓所有頁面內容位於拖拽條下方，拖拽條內不放控件。驗收時逐一點擊頂部附近元素，並 grep 非 `.fixed.inset-0` 的頂部固定元素。
- [Electron 不識別偽元素拖拽區] → D2 預留退回方案：preload 在 `<body>` 注入節點。
- [透明背景導致整窗透明或白閃] → `data-material` 只有在平台支援且已設置材質時才寫入；`.app-main` 始終不透明；不支援時不設 `vibrancy` / `backgroundMaterial`。
- [材質效果太淡或過亮] → 側邊欄透明度以截圖驗收調整，深 / 淺色、展開 / 收起、窗口聚焦 / 失焦分別截圖。
- [vibrancy 增加 GPU 合成開銷] → 只作用於側邊欄區域，主內容不透明；若低端機反饋卡頓，D3 的退回路徑就是不設 `vibrancy`。
- [Windows overlay 與頁面顏色不一致出現色塊] → overlay 顏色來自同一份主題常量，主題變化即時 `setTitleBarOverlay`；材質啟用時 overlay 顏色用透明。
- [`user-select: none` 誤傷可選內容] → 白名單恢復；驗收場景覆蓋聊天、代碼塊、終端、編輯器、輸入框。
- [字體平滑讓 Retina 以外屏幕的細字變淡] → 只作用於 macOS，與 VS Code / Slack 一致。
- [前端某處用 `cursor-pointer` 表達「這是鏈接」的語義] → 外部鏈接保留 pointer；其餘回到預設箭頭符合原生慣例。

## Migration Plan

純外觀變更，無數據遷移。`window-state.json` 不存在時走預設值；刪除該文件即可回到預設窗口。回滾：還原 `electron/` 與 `index.css` 中的桌面作用域段即可，瀏覽器端不受影響。

## Open Questions

- 標題條中央是否顯示當前項目 / 會話名（類似 VS Code 窗口標題）？本 change 先留空，等視覺重設計時一起決定。
- 是否需要設置頁提供「關閉半透明材質」開關？先不做；若有性能或可讀性反饋再加。
