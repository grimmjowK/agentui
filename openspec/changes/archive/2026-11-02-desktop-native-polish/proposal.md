## Why

桌面端（`desktop-electron-shell`）目前只是把網頁原樣裝進一個帶系統標題欄的窗口：頂部一條與主題無關的灰色標題欄、啟動頁固定深色導致淺色主題下閃屏、按鈕是手型游標、整個 UI 可被選中/拖拽、右鍵沒有任何菜單、窗口尺寸每次重置。這些細節疊加起來就是「網頁廉價感」。前一個 change 刻意選擇了系統標題欄以避免改前端（見其 design 的 `createWindow` 註釋），現在桌面端已可用，是時候把外殼做成原生桌面級質感。

## What Changes

- **一體化標題欄**：macOS 改 `titleBarStyle: 'hiddenInset'` + 自訂紅綠燈位置；Windows 改 `titleBarStyle: 'hidden'` + `titleBarOverlay`（顏色隨主題同步）。桌面模式下在全域層預留一條全寬拖拽條（`-webkit-app-region: drag`），所有畫面（驗證載入、登入、onboarding、主畫面、全屏彈窗）都為它讓位，全屏時收起。頂部接受「拖拽條 + 既有 header」雙層結構。
- **原生材質（macOS / Win11 22H2+）**：macOS 側邊欄區域使用 `vibrancy: 'sidebar'`，Windows 11 22H2（build 22621）及以上使用 `backgroundMaterial: 'mica'`；桌面材質模式下側邊欄降低底色不透明度使材質可見；不支援的系統自動退回不透明背景。
- **主題同步至原生外殼**：前端主題切換時單向通知 main 進程，同步 `nativeTheme.themeSource`、窗口 `backgroundColor` 與標題欄 overlay 顏色並持久化；冷啟動在建窗前套用上次主題（首次啟動跟隨系統），啟動頁跟隨該主題，消除淺色閃屏。
- **桌面專屬 CSS 細節**（僅在 `html[data-desktop]` 下生效，瀏覽器端零影響）：預設游標、UI chrome 不可選中、圖片/鏈接不可拖出、字體平滑、細滾動條、`:focus-visible` 焦點環、禁用雙指縮放。
- **原生菜單**：顯式的應用菜單（含 Edit/View/Window 標準角色與快捷鍵）+ 輸入框/選中文本的原生右鍵菜單（剪切/複製/貼上/全選、拼寫建議）。
- **窗口行為**：`show: false` + `ready-to-show` 避免白屏；窗口位置/尺寸/最大化狀態持久化；`minWidth` 提高到桌面佈局斷點以上，100% 縮放下桌面窗口不再落入移動端佈局（使用者主動放大頁面時允許響應式收合）。

不在本次範圍：整體視覺重設計（配色、字號、間距、組件重繪）、標題欄與 `MainContentHeader` 合併為單層工具列、持續跟隨系統主題（`system/light/dark` 三態）、自訂繪製的窗口按鈕、托盤圖標、Linux。

## Capabilities

### New Capabilities
- `desktop-native-appearance`: 桌面端的原生外觀與交互契約 —— 一體化標題欄與拖拽區、原生材質及退回策略、主題同步至原生外殼、桌面專屬交互樣式（且不影響瀏覽器端）、原生應用菜單與右鍵菜單、窗口狀態持久化與無閃屏啟動。

### Modified Capabilities
<!-- 無。desktop-shell 仍在進行中的 desktop-electron-shell change 裡，尚未歸檔到 openspec/specs/；本 change 只在其窗口之上疊加外觀行為，不改它的後端生命周期/認證/安全要求。 -->

## Impact

**修改**
- `electron/main.js`：`BrowserWindow` 選項（標題欄、材質、`show:false`、minWidth）、窗口狀態持久化、應用菜單、右鍵菜單、主題 IPC、桌面狀態快照 IPC、全屏事件轉發
- `electron/preload.js`：暴露 `setTheme`；在 `<html>` 上寫 `data-desktop` / `data-material` / `data-fullscreen`（初始狀態快照 + 全屏事件訂閱）
- `electron/startup.html`：跟隨上次主題（首次啟動跟隨系統）淺/深色，預留標題欄拖拽條
- `src/contexts/ThemeContext.jsx`：主題變更時呼叫 `window.cloudcliDesktop?.setTheme`（1 行）
- `src/index.css`：新增 `html[data-desktop]` 作用域的樣式段（全域拖拽條與讓位、材質開洞、交互樣式）
- `src/components/app/AppContent.tsx`：根節點與主內容列加 `app-shell` / `app-main` 鉤子類名
- `src/components/sidebar/view/subcomponents/SidebarContent.tsx`、`SidebarCollapsed.tsx`：根節點加 `app-sidebar` 鉤子類名

**不受影響**
- 瀏覽器 / PWA / 移動端：所有新樣式都掛在 `data-desktop` 之下，只有 preload 會設置它
- 後端、認證、打包配置

**風險點**
- 拖拽區吞掉點擊：頁面所有內容（含全屏彈窗）都必須讓位到拖拽條下方；非 `.fixed.inset-0` 的頂部固定元素需逐個排查。
- 視覺預期：本次交付的是外殼一體化與桌面操作手感；頁面本身的精緻度（密度、配色、單層工具列）需另開視覺 change。
- 透明窗口 + vibrancy/mica 依賴頁面背景透明，處理不當會出現整窗透明或閃爍；需可一鍵關閉的退回路徑。
- Windows `titleBarOverlay` 顏色需在主題切換時即時更新，否則出現色塊。
