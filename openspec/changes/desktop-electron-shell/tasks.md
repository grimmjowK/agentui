## 1. 后端端口交接

- [x] 1.1 在 `server/index.js:1411` 的 listen 回调中，用 `server.address().port` 输出一行 `CLOUDCLI_LISTENING {"port":<n>}` 到 stdout（这是后端唯一改动）
- [x] 1.2 验证三条端口路径行为不变：`SERVER_PORT=0`（内核分配）、显式 `SERVER_PORT=8080`、默认 3001；`npm run dev` 与 `node dist-server/server/index.js` 照旧可用

## 2. Electron 外壳骨架

- [x] 2.1 添加 devDependencies：`electron`、`electron-builder`、`@electron/rebuild`
- [x] 2.2 创建 `electron/main.js`：单实例锁（未获取则立即退出，已有实例还原并聚焦主窗口）
- [x] 2.3 创建主窗口，`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- [x] 2.4 拦截 `setWindowOpenHandler` 与 `will-navigate`：非 `http://127.0.0.1:<port>` 与启动页的目标交给系统浏览器
- [x] 2.5 创建 `electron/startup.html` + `electron/preload.js`，暴露白名单 IPC（状态订阅、重试）
- [x] 2.6 main 进程内联 `data:` URL 兜底错误文档，用于启动页资源或 preload 加载失败时

## 3. 后端子进程生命周期

- [x] 3.1 实现 `spawn(process.execPath, [serverEntry], { env: { ELECTRON_RUN_AS_NODE: '1', HOST: '127.0.0.1', SERVER_PORT: '0', ... } })`
- [x] 3.2 逐行解析子进程 stdout，匹配 `CLOUDCLI_LISTENING` 取得端口；60 秒未就绪则终止子进程并报超时
- [x] 3.3 就绪后导航主窗口到 `http://127.0.0.1:<port>`；未就绪期间停留在启动页加载态
- [x] 3.4 监听子进程 `close`/`error`：非预期退出时导航回启动页并展示 stderr 摘要与「重试」
- [x] 3.5 实现「重试」：终止残留子进程后重新 spawn，回到加载态
- [x] 3.6 `before-quit` 中阻止默认退出，先停后端；`SIGTERM` 后 10 秒未退出则 `SIGKILL`，其后完成退出
- [x] 3.7 `window-all-closed`(非 darwin) 与 `activate` 的标准生命周期处理

## 4. PATH 解析

- [x] 4.1 在 darwin/linux 上执行一次 `$SHELL -ilc 'echo $PATH'`，带超时与失败兜底（回退当前 `process.env.PATH`），结果缓存
- [x] 4.2 将解析到的 PATH 合并进后端子进程环境；Windows 跳过
- [x] 4.3 让外部 CLI 解析失败的错误信息带上实际使用的 PATH

## 5. 桌面端免登录

- [x] 5.1 main 进程检查 `safeStorage.isEncryptionAvailable()`，不可用时明确报错而非静默降级
- [x] 5.2 首次启动：生成随机凭据 → 调 `/api/auth/register` → `safeStorage` 加密存盘
- [x] 5.3 后续启动：读凭据 → 调 `/api/auth/login` 取 token
- [x] 5.4 通过 `webContents` 在页面加载前注入 token 到 `localStorage`
- [x] 5.5 注册或登录失败时，直接加载应用让现有登录界面接管，不绕过认证
- [x] 5.6 加一条断言性检查，确认桌面路径完全不触碰 `IS_PLATFORM`：桌面后端子进程环境中 `VITE_IS_PLATFORM` 必须未设置或非 `'true'`，并在 spawn 前显式剔除该变量（当前分支 `server/middleware/auth.js:25,94` 的 `IS_PLATFORM` 分支对 HTTP 与 WebSocket 均直接放行，无任何密钥校验）

## 6. 打包配置

- [x] 6.1 创建 `electron-builder.config.js`：`files` 仅含 `electron/**` 与根 `package.json`
- [x] 6.2 配置 `extraResources`：`dist/`、`dist-server/`、`node_modules/`、`package.json` → `resources/app/`
- [x] 6.3 后端入口解析为 `path.join(process.resourcesPath, 'app', 'dist-server', 'server', 'index.js')`，开发态回退到项目内路径
- [x] 6.4 打包前置步骤中加入 `@electron/rebuild --only better-sqlite3`，按 Electron ABI 重编；**不要**全量 rebuild —— `node-pty` 走 prebuildify/N-API（`prebuilds/<platform>-<arch>/pty.node`），ABI 无关，强行重编反而会把可用的 prebuild 换成一次本地源码编译
- [x] 6.5 处理 spawn-helper 可执行位：`scripts/fix-node-pty.js` 是 postinstall 钩子、只作用于源码树，打包产物里不会再跑；改为在 `electron-builder.config.js` 的 `afterPack` 中对产物内 `**/node-pty/prebuilds/*/spawn-helper` 再 chmod 0755（幂等，不依赖 extraResources 是否保留 mode）
- [x] 6.6 配置 mac (`dmg`/`zip`) 与 win (`nsis`) 目标，暂不启用签名与公证
- [x] 6.7 添加 npm 脚本：`desktop:dev`、`desktop:build`、`desktop:package`
- [x] 6.8 确认根 `package.json` 的 `files` 字段不含 `electron/`，`npx cloudcli` 分发不受影响

## 7. 验证

- [ ] 7.1 开发态跑通：`desktop:dev` 能启动、加载页面、完成一次对话（后端已验证起来：端口 60225 回报正确、`GET /` 返回 200、`/api/auth/status` 正常；「完成一次对话」需人工在窗口内操作）
- [ ] 7.2 打包产物冒烟：安装后启动，验证 SQLite 读写正常（项目列表可加载）
- [ ] 7.3 打包产物冒烟：验证 node-pty 正常（Shell 面板可开终端并执行命令）
- [ ] 7.4 打包产物冒烟：验证 ripgrep 正常（会话搜索有结果返回）
- [ ] 7.5 从 Finder / 开始菜单（非终端）启动，验证外部 CLI 可被解析到
- [ ] 7.6 验证退出后无孤儿后端进程残留（`ps` 检查）
- [x] 7.7 验证后端启动失败场景：开发态首跑真实触发了 better-sqlite3 ABI 不匹配（NODE_MODULE_VERSION 147 vs 149），启动页展示错误；`electron-rebuild` 后经「重试」成功拉起后端（`CLOUDCLI_LISTENING` 出现在 ABI 报错之后，而 `second-instance` 处理器只做 restore+focus，不触发重试）
- [x] 7.8 验证单实例：第二次 `desktop:dev` 立即 EXIT=0 退出，未产生第二个窗口
- [x] 7.9 验证仅绑回环：`lsof -nP -iTCP -sTCP:LISTEN -p <backend>` 显示 `127.0.0.1:60225 (LISTEN)`，非 `*:60225`
- [x] 7.10 `npx tsc --noEmit -p server/tsconfig.json` 通过、`npm run lint` 0 error、`npx eslint electron/ electron-builder.config.js` 干净；注意 `npm run typecheck` 的第一段 `tsc -p tsconfig.json` 在本分支本就跑不了——根 `tsconfig.json` 已在 `7f44de0` 中被删除且不再被 git 跟踪（既有问题，与本变更无关）
