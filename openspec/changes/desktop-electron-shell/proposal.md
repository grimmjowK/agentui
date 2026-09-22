## Why

CloudCLI UI 目前只能以「先起服务、再开浏览器」的方式使用，用户需要自己管理 `npm run server` 进程、记住端口、在浏览器里另开标签页。对于一个本地开发者工具来说，这层摩擦没有必要存在。桌面端可以把服务生命周期、端口、登录态全部收进一个可双击启动的应用里。

参考 deepseek-harness 的桌面端实现（Electron 外壳 + 后端子进程 + 复用同一份 Web 前端），确认这条路对 CloudCLI 成立，且前端无需改造 —— 现有前端所有 API/WebSocket 地址已经是 origin 相对的（`src/utils/api.js:19`、`src/contexts/WebSocketContext.tsx:31`、`src/components/shell/utils/socket.ts:8`），后端 `HOST`/`SERVER_PORT` 已是环境变量且在 `dist/` 存在时自带静态托管与 SPA fallback。

## What Changes

- 新增 `electron/` 目录：Electron main 进程与 preload，负责窗口、菜单、生命周期。
- 后端以**独立子进程**运行现有 `dist-server/server/index.js`，绑定 `127.0.0.1` + 动态端口；Electron 窗口加载 `http://127.0.0.1:<port>`。前端代码零改动。
- `server/index.js` 在监听成功后把实际端口以结构化单行输出到 stdout，供父进程读取，消除「先探测端口再交给子进程」的竞争。`SERVER_PORT=0` 已被现有代码天然支持，无需改动默认值逻辑。
- 新增启动页：后端就绪前显示加载态，后端启动失败时显示错误与「重试 / 重启」操作，该页面不依赖后端。
- 桌面端免登录：main 进程用 Electron `safeStorage` 持久化桌面专用凭据，首次启动自动完成注册/登录并把 token 注入页面。**不复用 `IS_PLATFORM` 的未认证路径，并在 spawn 后端前显式剔除 `VITE_IS_PLATFORM`。**
- 新增 electron-builder 打包配置，产出 macOS / Windows 安装包；`dist/`、`dist-server/`、`node_modules` 走 `extraResources` 不进 asar。
- 处理 GUI 启动环境的 `PATH` 问题，保证 `claude`/`codex`/`gemini`/`cursor` 等外部 CLI 可被 spawn 到。
- `better-sqlite3` 按 Electron ABI 重编（`node-pty` 走 N-API prebuild，不参与重编）。
- 新增 npm 脚本：`desktop:dev`、`desktop:build`、`desktop:package`。

不在本次范围内：自动更新（electron-updater）、代码签名与公证、Linux 发行包、应用内插件安装体系。

## Capabilities

### New Capabilities
- `desktop-shell`: Electron 桌面外壳的行为契约 —— 后端子进程生命周期（启动/就绪探测/失败恢复/退出顺序）、窗口与启动页状态机、桌面端免登录与本地回环安全边界、外部 CLI 的 PATH 解析、单实例约束。

### Modified Capabilities
<!-- 无。`openspec/specs/` 下现有 spec 均为 provider 层行为，不受影响。 -->

## Impact

**新增**
- `electron/main.js`、`electron/preload.js`、`electron/startup.html`
- `electron-builder.config.js`
- devDependencies：`electron`、`electron-builder`、`@electron/rebuild`

**修改**
- `server/index.js`：listen 回调中增加一行端口回报（1 行）
- `package.json`：新增 desktop 脚本、`main` 字段不变（CLI 入口保持）
- `scripts/fix-node-pty.js`：确认其 spawn-helper chmod 在 `extraResources` 路径布局下仍能命中

**不受影响**
- `src/` 全部前端代码
- `server/` 除 `index.js` 那一行 stdout 输出外的全部逻辑
- 现有 `npm run dev` / CLI 分发方式（`npx cloudcli`）继续可用

**风险点**
- `better-sqlite3`（node-gyp / V8 API）ABI 不匹配会导致后端子进程启动即崩溃。`node-pty` 是 N-API prebuild，不受影响 —— 但也因此**不能**对它做全量 rebuild。
- macOS 从 Finder 启动时 `PATH` 极简，外部 CLI 找不到 —— 这是桌面化后最容易出现的运行时故障。
- asar 打包会破坏 `server/utils/runtime-paths.js` 的 `findAppRoot` 向上查找逻辑。
- 安装包体积：`node_modules` 实测 991 MB，整棵进 `extraResources` 后 macOS 包预计 500 MB 量级。
- 当前分支 `server/middleware/auth.js:25,94` 的 `IS_PLATFORM` 分支对 HTTP 与 WebSocket 均无条件放行，而后端具备 spawn 外部 CLI 与 pty 的能力。桌面端必须保证该开关在子进程中不为 true。
