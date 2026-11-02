## 1. 窗口基礎（D7）

- [x] 1.1 `electron/main.js`：新增 `userData/window-state.json` 讀寫（`x/y/width/height/isMaximized/theme`），`close` 時用 `getNormalBounds()` 存檔
- [x] 1.2 恢復前用 `screen.getAllDisplays()` 校驗位置落在某個 `workArea` 內，否則只保留尺寸並居中
- [x] 1.3 `BrowserWindow` 改 `show: false` + `ready-to-show` 顯示（上次最大化則 `maximize()`），`minWidth` 改 960
- [x] 1.4 `backgroundColor` 按存檔主題取淺/深常量（註明對應 `index.css` 的 `--background`）；有存檔時建窗前把 `nativeTheme.themeSource` 設為存檔主題，無存檔時保持 `'system'`

## 2. 桌面標記與狀態快照（D1）

- [x] 2.1 `electron/preload.js`：先完成 `contextBridge` 暴露（新增 `setTheme(theme)`），再做 DOM 初始化；DOM 初始化包 try/catch
- [x] 2.2 preload：根元素存在則立即寫 `data-desktop = process.platform`，否則用 `MutationObserver` 監聽 `document`，在 `<html>` 插入時寫入
- [x] 2.3 main：新增同步 IPC `cloudcli:get-desktop-state`，返回 `{ material, fullscreen }`（`fullscreen` 取 `win.isFullScreen()`）；preload 據此寫 `data-material` / `data-fullscreen`
- [x] 2.4 main 轉發 `enter-full-screen` / `leave-full-screen`，preload 切換 `data-fullscreen`
- [ ] 2.5 驗證：啟動頁與應用頁都帶 `data-desktop` 且 bridge 可用；全屏中重新整理、啟動頁 → 應用頁導航、後端崩潰回啟動頁後 `data-fullscreen` 正確

## 3. 主題同步（D4）

- [x] 3.1 main 處理 `cloudcli:set-theme`：設置 `themeSource`、`setBackgroundColor`、Windows 上 `setTitleBarOverlay`（材質啟用時 `color` 透明），並寫回窗口狀態文件
- [x] 3.2 `src/contexts/ThemeContext.jsx`：主題 effect 末尾呼叫 `window.cloudcliDesktop?.setTheme(...)`
- [x] 3.3 `electron/startup.html`：改用 `prefers-color-scheme` 兩套顏色變量，頂部預留拖拽條
- [ ] 3.4 驗證：首次啟動跟隨系統主題無閃屏；選淺色後在深色系統重啟全程淺色；應用內切換主題後原生菜單與 Windows 控制按鈕同步變色，無明顯色塊殘留

## 4. 一體化標題欄（D2）

- [x] 4.1 macOS：`titleBarStyle: 'hiddenInset'` + `trafficLightPosition`（紅綠燈垂直居中於 38px 條）
- [x] 4.2 Windows：`titleBarStyle: 'hidden'` + `titleBarOverlay: { color, symbolColor, height: 36 }`
- [x] 4.3 `src/index.css`：`html[data-desktop]` 下定義 `--titlebar-height`（darwin 38px / win32 36px / `data-fullscreen` 時 0）；`body::before` 固定全寬拖拽條（`-webkit-app-region: drag`、最上層、背景透明）
- [x] 4.4 `src/index.css`：讓位規則 —— `.fixed.inset-0 { top: var(--titlebar-height) }`、`#root { padding-top: var(--titlebar-height) }`、`.min-h-screen { min-height: calc(100vh - var(--titlebar-height)) }`
- [x] 4.5 grep 排查非 `.fixed.inset-0` 的頂部固定元素（`fixed top-0` 等），逐個確認不進入拖拽區
- [ ] 4.6 若偽元素拖拽區在 Electron 中不生效，改由 preload 在 `<body>` 下注入 `#desktop-titlebar` 節點，樣式不變
- [ ] 4.7 驗證：主畫面、驗證載入、登入、首次設定、onboarding、設置窗、命令面板各畫面頂部都有拖拽區且內容不被遮擋、無多餘滾動條；拖動、雙擊縮放、全屏收起；側邊欄展開/收起時窗口控制按鈕均不壓內容；瀏覽器打開同一地址無任何變化

## 5. 原生材質（D3）

- [x] 5.1 main：macOS 設 `vibrancy: 'sidebar'` + `visualEffectState: 'followWindow'`；Windows 僅 build ≥ 22621 設 `backgroundMaterial: 'mica'`；結果經 2.3 的 `material` 返回
- [x] 5.2 `AppContent.tsx` 根節點加 `app-shell` 類名，主內容列加 `app-main` 類名；`SidebarContent.tsx`、`SidebarCollapsed.tsx` 根節點加 `app-sidebar` 類名
- [x] 5.3 `index.css`：`html[data-desktop][data-material]` 下 `body` / `.app-shell` 背景透明；`.app-sidebar` 改 `background-color: hsl(var(--background) / 0.35)`、`backdrop-filter: none`；`.app-main` 保持 `bg-background`
- [ ] 5.4 截圖調整 `.app-sidebar` 透明度（深/淺色可分別取值），確認材質可見且側邊欄文字可讀
- [ ] 5.5 驗證：macOS 側邊欄與拖拽條透出材質、主內容不透明；開啟「減少透明度」後無整窗透明；Windows 10 與 Windows 11 21H2 無 `data-material` 且為不透明背景；Windows 11 22H2+ 透出 mica、控制按鈕無色塊、關閉「透明效果」後無整窗透明

## 6. 桌面交互樣式（D5）

- [x] 6.1 `index.css` 桌面段：`button, [role=button], a, summary, label, .cursor-pointer` 使用 `cursor: default`，外部鏈接 `a[href^="http"]` 保留 pointer
- [x] 6.2 `.app-shell` `user-select: none`，白名單恢復聊天消息、`pre/code/.prose`、`.xterm`、`.cm-editor`、輸入框、`contenteditable`
- [x] 6.3 `img, a { -webkit-user-drag: none }`、`-webkit-font-smoothing: antialiased`、`:focus-visible` 焦點環、全局細滾動條
- [x] 6.4 main：`webContents.setVisualZoomLevelLimits(1, 1)` 禁用雙指縮放
- [ ] 6.5 驗證：側邊欄快速點擊無選中高亮；側邊欄項目操作按鈕（帶 `cursor-pointer`）懸停為箭頭；聊天/代碼/終端可選中複製；觸控板捏合不縮放；Cmd/Ctrl +/- 仍可縮放

## 7. 原生菜單（D6）

- [x] 7.1 main：`Menu.setApplicationMenu` 標準角色模板（macOS appMenu/editMenu/viewMenu/windowMenu；Windows fileMenu/editMenu/viewMenu），DevTools 僅未打包時
- [x] 7.2 main：`webContents.on('context-menu')` 根據 `isEditable` / `selectionText` / `editFlags` / `dictionarySuggestions` 構造原生右鍵菜單，兩者皆無時不彈
- [ ] 7.3 驗證：輸入框右鍵出現剪切/複製/貼上/全選且狀態正確；拼寫建議可替換；文件樹等自訂右鍵菜單不受影響

## 8. 收尾

- [x] 8.1 `npm run typecheck`、`npm run lint`、`npm run build` 通過
- [ ] 8.2 `npm run desktop:package` 打包後在 macOS 實機走一遍第 2–7 組驗證項
- [ ] 8.3 Windows 實機（至少 Windows 10 或 Windows 11 21H2 其一，加 Windows 11 22H2+）走一遍第 2–7 組驗證項
- [ ] 8.4 固定窗口尺寸（1440×900）與相同會話內容，截圖前後對比：深/淺色 × 側邊欄展開/收起 × 窗口聚焦/失焦，另加設置窗、登入頁、全屏各一張
- [ ] 8.5 驗證 100% 縮放下拖到最窄仍為桌面佈局；記錄放大後切到移動端佈局的縮放比例，確認符合 D7 預期
- [x] 8.6 更新 `server/SERVER.md` / `src/SRC.md` 中與桌面外殼相關的說明（如有）
