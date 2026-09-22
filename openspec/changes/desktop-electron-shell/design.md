## Context

CloudCLI UI 现在是「Express + WebSocket 后端 + Vite/React 前端」的本地 Web 应用，用户需要自己启动服务并在浏览器打开。目标是把它变成可双击启动的桌面应用。

调研了 deepseek-harness（`apps/desktop`、`apps/desktop-host`）的做法作为参考：Electron main 进程通过 `protocol.handle('dsh-app://')` 拦截所有请求，把标准 `Request` 编码成自定义二进制帧，经子进程的 fd 3/4 管道转发给后端，再把响应帧重组成 `Response`，全程不开任何监听端口、不使用 WebSocket。

**这套方案对 CloudCLI 不成立。** 它的前提是 deepseek-harness 的客户端传输层从一开始就是可插拔的（`@deepseek-ai/dsh-client-connection` 在 web 模式走 HTTP + WebSocket，在 Electron 模式走 `connection.rpc.open` 落到管道）。CloudCLI 恰好相反 —— `src/contexts/WebSocketContext.tsx:71` 和 `src/components/shell/hooks/useShellConnection.ts:126` 直接 `new WebSocket()`，后端 `server/index.js:108` 把 chat / shell / plugin-proxy / auth 四个 WebSocket service 挂在 http server 的 upgrade 事件上。复用那条管道等于重写整个通信层。

同时 CloudCLI 已经具备走「本地端口」这条捷径的全部条件：前端所有地址是 origin 相对的（`src/utils/api.js:19`、`src/contexts/WebSocketContext.tsx:31`、`src/components/shell/utils/socket.ts:8` 全部基于 `window.location.host`）、后端 `HOST`/`SERVER_PORT` 已是环境变量（`server/index.js:1383-1384`）、`dist/` 存在时后端自带静态托管与 SPA fallback（`server/index.js:216,1259`）。

## Goals / Non-Goals

**Goals:**
- 前端代码零改动，后端改动控制在启动段十行以内。
- 一个可双击启动的应用，进程与端口对用户完全不可见。
- 后端崩溃不连带 UI 崩溃，且有可见的错误与重试路径。
- 退出时后端进程必定被回收，不留孤儿进程持有 SQLite 与 pty。
- 现有 `npm run dev` 与 `npx cloudcli` 分发方式完全不受影响。

**Non-Goals:**
- 不做自动更新、代码签名、公证。
- 不做 Linux 发行包。
- 不做应用内插件安装（deepseek-harness 的 profile/pnpm 体系整套不引入）。
- 不做系统托盘、全局快捷键、深链接。
- 不改造前端通信层，不引入任何非 HTTP/WebSocket 的传输方式。

## Decisions

### D1：本地回环端口 + Electron 壳，而非自定义协议 + 帧管道

**选择**：后端子进程监听 `127.0.0.1:<随机端口>`，Electron 窗口 `loadURL('http://127.0.0.1:<port>')`。

**理由**：前端与后端之间的契约完全不变，WebSocket、文件上传、SSE、静态资源全部照旧工作。实现量约 200 行。

**备选（已否决）**：照抄 deepseek-harness 的 `dsh-app://` + fd 管道。收益是不开端口（省掉端口占用、CORS、暴露面问题），代价是重写前端 WebSocket 层与后端四个 ws service。CloudCLI 通过「只绑 `127.0.0.1` + 保留现有 JWT 认证」已经覆盖了同样的安全目标，不值得为此重写通信层。

### D2：后端跑独立子进程，而非在 main 进程内 require

**选择**：`spawn` 一个独立进程运行 `dist-server/server/index.js`。这一点直接沿用 deepseek-harness 的结构。

**理由**：后端会 spawn 外部 CLI、开 pty、加载两个原生模块、写 SQLite —— 任何一处崩溃都不应该带走窗口。独立进程还让「重试」成为一次干净的重启，而不是在同一个 V8 堆里收拾残局。

**备选（已否决）**：main 进程内直接 `import` 后端。省掉一次进程启动（约 1–2 秒），但崩溃隔离、重启语义、原生模块加载失败的可诊断性全部变差。

### D3：后端子进程用 Electron 的 Node（`ELECTRON_RUN_AS_NODE=1`），只重编 better-sqlite3

**选择**：`spawn(process.execPath, [serverEntry], { env: { ELECTRON_RUN_AS_NODE: '1', ... } })`，打包时用 `@electron/rebuild` **仅**把 `better-sqlite3` 按 Electron ABI 重编。

**理由**：不需要额外打包一份 Node 二进制（约 50MB）。两个原生模块的情况并不相同，已核对当前 `node_modules`：

| 模块 | 产物 | 结论 |
| --- | --- | --- |
| `better-sqlite3@12` | `build/Release/better_sqlite3.node`（node-gyp，绑 V8 API） | 受 `NODE_MODULE_VERSION` 约束，**必须**按 Electron ABI 重编 |
| `node-pty@1.2.0-beta` | `prebuilds/<platform>-<arch>/pty.node`（prebuildify，N-API） | ABI 无关，Electron 下直接可用，**不重编** |

对 node-pty 跑 `@electron/rebuild --force` 会把现成的 N-API prebuild 换成一次本地源码编译 —— 那是引入风险而不是消除风险（需要 Xcode CLT / VS Build Tools，且 beta 版源码编译路径远不如 prebuild 稳）。因此 rebuild 步骤必须用 `--only better-sqlite3` 限定范围，而不是全量 rebuild。

**备选（保留为回退方案）**：像 deepseek-harness 那样在 `extraResources` 内置一份真 Node 二进制来跑后端。好处是现有 npm prebuild 直接可用、零重编，Electron 升级不影响后端。如果 better-sqlite3 在某个平台上重编反复失败，切到这个方案，改动只在 spawn 的第一个参数与打包配置。

**实现中确认的两个后果**（已实测，Node 22 ABI 147 vs Electron 44 ABI 149）：

1. **开发态同样需要重编**。`desktop:dev` 直接跑 `electron electron/main.js` 会在后端子进程加载 better-sqlite3 时立刻崩溃，所以脚本定义为 `npm run desktop:rebuild && electron electron/main.js`；`@electron/rebuild` 对已是目标 ABI 的模块会跳过，只有首次慢。
2. **重编会把仓库的 better-sqlite3 切到 Electron ABI，从而让 `npm run server` / `npm run dev` 跑不起来**——同一份 `node_modules` 不能同时满足两个 ABI。为此提供 `npm run desktop:restore-node-abi`（即 `npm rebuild better-sqlite3`），并把它串在 `desktop:package` 末尾自动恢复；打包中途失败时需要手动跑一次。

### D4：端口通过子进程 stdout 单行交接

**选择**：后端以 `SERVER_PORT=0` 启动，监听成功后向 stdout 输出一行 `CLOUDCLI_LISTENING {"port":<n>}`；main 进程逐行读取直到匹配。

**理由**：消除 TOCTOU 竞争。父进程先探测空闲端口再交给子进程，中间窗口内端口可能被别的进程抢走 —— 在开发机上并不罕见。

**后端改动只有一行。** 已实测确认无需为 `SERVER_PORT=0` 改动默认值逻辑：环境变量取到的是字符串 `"0"`（truthy），`process.env.SERVER_PORT || 3001` 不会把它吞成 3001；`server.listen("0", host)` 由内核分配端口，`server.address().port` 正常返回。所以改动就是在 `server/index.js:1411` 的 listen 回调里加一行输出。

**备选（已否决）**：父进程探测端口后传给子进程（有竞争）；写临时文件握手（多一处需要清理的状态，且要处理陈旧文件）。

### D5：免登录走「持久化凭据 + 现有登录接口」，而非新增免认证路径

**选择**：main 进程首次启动时生成随机用户名/密码，调用现有 `/api/auth/register`，用 Electron `safeStorage` 加密存盘；后续启动调 `/api/auth/login` 拿 token，在页面加载前注入 `localStorage`。

**理由**：认证链路一行不改，后端不新增任何可绕过认证的分支。

**这是硬约束，不是偏好。** 当前分支的 `server/middleware/auth.js:25` 与 `:94` 里，`IS_PLATFORM` 为 true 时 HTTP 与 WebSocket 认证**双双直接放行**，没有任何共享密钥校验 —— 后端同时提供 spawn 外部 CLI 与 pty 的能力，等于一条未认证的本地 RCE 路径。桌面端若为了省事去复用它，就是把这条路径固化进一个双击即启动的应用里。因此桌面端 MUST NOT 触碰 `IS_PLATFORM`，且需要一条断言性验证（见 tasks 5.6）而不是靠"注意不要用"。

**边界情况**：如果用户此前已通过 Web 端建过账号，`/api/auth/register` 会因 `server/routes/auth.js:43` 的单用户校验返回 403（`User already exists. This is a single-user system.`）—— 此时退回到现有登录界面由用户手动处理，而不是尝试绕过。

### D6：打包布局 —— 应用代码进 asar，运行时资产进 extraResources

**选择**：
- `files`: 只含 `electron/**` 与根 `package.json`，进 `app.asar`。
- `extraResources`: `dist/`、`dist-server/`、`node_modules/`、`package.json` 映射到 `resources/app/`，**不进 asar**。
- 后端入口解析为 `path.join(process.resourcesPath, 'app', 'dist-server', 'server', 'index.js')`。

**理由**：`server/utils/runtime-paths.js` 的 `findAppRoot` 靠向上查找 `package.json` 定位应用根，asar 内的虚拟路径会让它失效或指向错误位置。把整棵运行时资产留在真实文件系统上，`findAppRoot`、ripgrep 二进制、node-pty 的 `spawn-helper`、`.node` 文件全部按原样工作，不需要逐项 `asarUnpack`。

**备选（已否决）**：`asar: true` + 逐项 `asarUnpack`（deepseek-harness 的做法，清单为 `**/*.{node,dylib,dll,so,exe}`、`**/spawn-helper`、`**/@vscode/ripgrep/bin/rg`）。对他们成立是因为后端路径解析不依赖向上查找；对我们要额外改 `findAppRoot`，不如直接不进 asar。`asar: false` 全量展开则会产生大量小文件，Windows 安装明显变慢。

### D7：PATH 用登录 shell 现取现用

**选择**：仅在 darwin/linux 上，main 进程启动时执行一次 `$SHELL -ilc 'echo $PATH'`，结果缓存并合并进后端子进程环境。

**理由**：macOS 从 Finder 启动的应用拿到的是 `/usr/bin:/bin:/usr/sbin:/sbin`，`claude`、`codex` 这类装在 `~/.local/bin`、nvm、homebrew 下的 CLI 一律找不到。这是桌面化之后最高频的运行时故障，且现象具有误导性（用户终端里明明能跑）。约 5 行代码，不引入 `fix-path` 这类依赖。deepseek-harness 把 agent 做在进程内，没有这个问题，所以此处无可参考。

### D8：启动页是本地文件，不依赖后端

**选择**：`electron/startup.html` 由 `file://` 或自定义协议加载，承载加载态与错误态；错误态提供「重试」。启动页自身加载失败时回退到 main 进程内联的 `data:` URL 文档。

**理由**：沿用 deepseek-harness 的结构（`renderer/startup.html` + `startupFailureDocument` 兜底）。后端起不来时用户必须能看到原因，而不是白屏。

## Risks / Trade-offs

- **原生模块 ABI 不匹配** → 后端子进程启动即崩溃，且错误信息（`NODE_MODULE_VERSION` 不符）对终端用户无意义。缓解：打包流程中固化 `@electron/rebuild --only better-sqlite3`（按 D3，node-pty 不参与）；任务里加一条打包产物冒烟检查，实际拉起后端并完成一次 SQLite 读写与一次 pty 会话；失败则按 D3 备选切到内置 Node。

- **PATH 补全在非常规 shell 下失效**（fish、用户自定义 rc 有交互式输出等） → 外部 CLI 仍然找不到。缓解：`$SHELL -ilc` 调用加超时与失败兜底（退回当前 PATH），并让失败信息带上实际使用的 PATH，使问题可自助诊断。

- **桌面端与 CLI 端并行运行** → 两个后端同时操作同一份 SQLite 与 `~/.claude`。单实例锁只覆盖桌面应用，不阻止用户同时跑 `npx cloudcli`。这是既有行为，本次不收敛；仅在文档中说明。

- **`safeStorage` 在部分 Linux 桌面环境无可用 keyring** → 退化为明文存储。由于本次不发 Linux 包，暂不处理；实现时对 `safeStorage.isEncryptionAvailable()` 为 false 的情况明确报错而非静默降级。

- **应用体积** → 当前 `node_modules` 实测 **991 MB**（含 better-sqlite3、node-pty 六平台 prebuilds、ripgrep、sharp、四家 AI SDK）。整棵进 `extraResources` 后 macOS 安装包预计 500 MB 量级。取舍：换取零运行时安装、零路径解析改造。裁剪的第一刀是最明确的那几处 —— node-pty 只保留当前 `<platform>-<arch>` 的 prebuild、sharp 只保留当前平台、devDependencies 完全排除；这几项就能砍掉大半，且不触碰 D6 的路径假设。本次不做，见 Open Questions。

- **多一次进程启动的冷启动延迟**（约 1–2 秒，SQLite 初始化 + 项目扫描）→ 由启动页承载，用户看到的是加载态而非白屏。

## Migration Plan

纯新增，无破坏性变更：

1. 后端端口回报先行合入 —— 仅在 listen 回调里增加一行 stdout 输出，对现有 `npm run dev`、`npx cloudcli` 零行为影响（`SERVER_PORT=0` 无需改代码，见 D4）。
2. `electron/` 与打包配置合入，不改动默认 `npm run build` / `npm start`。
3. 桌面包通过新增的 `desktop:package` 脚本单独产出，不进入现有 npm 发布流程（`package.json` 的 `files` 字段不含 `electron/`）。

**回滚**：停止分发桌面包即可。后端侧唯一改动是 listen 回调里的一行 stdout 输出，可独立保留或还原，不影响其他功能。

## Open Questions

- 打包产物体积达到什么量级需要启动生产依赖裁剪？基线已知：`node_modules` 991 MB，预计安装包 500 MB 量级。若首个包确实落在这个区间，按 Risks 里列的三刀（node-pty 单平台 prebuild、sharp 单平台、排除 devDependencies）做一轮，再看是否需要更细的裁剪。
- 是否需要系统托盘 / 关闭窗口时后台驻留？当前按「关闭即退出」实现，等实际使用反馈再定。
- 自动更新（electron-updater + generic provider）何时引入，以及更新源托管在哪里 —— 本次明确不做，但打包配置预留不冲突。
