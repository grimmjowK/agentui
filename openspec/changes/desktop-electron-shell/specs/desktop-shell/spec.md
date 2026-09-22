## ADDED Requirements

### Requirement: 后端子进程生命周期
桌面应用 SHALL 在独立子进程中运行现有 Node 后端（`dist-server/server/index.js`），而不是在 Electron main 进程内 require 它。Main 进程 SHALL 持有该子进程的唯一引用，并在应用退出前终止它。

#### Scenario: 应用启动时拉起后端
- **WHEN** 用户启动桌面应用
- **THEN** main 进程 spawn 一个后端子进程，环境变量包含 `HOST=127.0.0.1` 与 `SERVER_PORT=0`

#### Scenario: 后端进程意外退出
- **WHEN** 后端子进程在应用运行期间以非零码退出
- **THEN** main 进程捕获退出事件，将窗口导航到启动页并展示错误信息与「重试」操作

#### Scenario: 应用退出先停后端
- **WHEN** 用户退出应用
- **THEN** main 进程先阻止默认退出，向后端子进程发送终止信号并等待其退出，然后才真正退出

#### Scenario: 后端拒绝退出
- **WHEN** 后端子进程在收到 `SIGTERM` 后 10 秒内未退出
- **THEN** main 进程发送 `SIGKILL`，并在其后仍完成应用退出

### Requirement: 动态端口分配与就绪探测
后端 SHALL 支持 `SERVER_PORT=0` 由操作系统分配端口，并在监听成功后将实际端口以结构化单行写入 stdout。Main 进程 SHALL 通过读取该行获知端口，而不是自行预先探测空闲端口。

#### Scenario: 后端回报实际端口
- **WHEN** 后端以 `SERVER_PORT=0` 启动并成功监听
- **THEN** 后端向 stdout 输出一行可被机器解析的端口声明（如 `CLOUDCLI_LISTENING {"port":54321}`）

#### Scenario: Main 进程等待就绪
- **WHEN** main 进程尚未从子进程 stdout 读到端口声明
- **THEN** 窗口停留在启动页，不发起任何 `http://127.0.0.1` 导航

#### Scenario: 启动超时
- **WHEN** 后端在 60 秒内未输出端口声明
- **THEN** main 进程终止该子进程，并在启动页展示超时错误与「重试」操作

#### Scenario: 显式端口仍然可用
- **WHEN** 环境变量指定了非零的 `SERVER_PORT`
- **THEN** 后端监听该指定端口，现有 `npm run server` 与 `npx cloudcli` 行为不变

### Requirement: 启动页与错误恢复
桌面应用 SHALL 提供一个不依赖后端的本地启动页，用于承载后端就绪前的加载态与启动失败后的恢复操作。

#### Scenario: 加载态
- **WHEN** 应用启动且后端尚未就绪
- **THEN** 主窗口显示启动页的加载态

#### Scenario: 后端就绪后导航
- **WHEN** main 进程获知后端端口且该端口可访问
- **THEN** 主窗口导航到 `http://127.0.0.1:<port>`

#### Scenario: 重试
- **WHEN** 用户在启动页错误态点击「重试」
- **THEN** main 进程重新 spawn 后端子进程并重新进入加载态

#### Scenario: 启动页资源缺失
- **WHEN** 启动页自身的资源无法加载
- **THEN** 应用回退到内联的错误文档，该文档不依赖 preload 即可展示错误信息

### Requirement: 单实例约束
桌面应用 SHALL 在同一台机器上只允许一个实例运行，避免两个后端进程同时操作同一份 SQLite 数据库与 `~/.claude` 配置。

#### Scenario: 重复启动
- **WHEN** 应用已在运行，用户再次启动它
- **THEN** 第二个实例立即退出，已有实例的主窗口被还原并聚焦

### Requirement: 桌面端免登录与本地回环边界
桌面应用 SHALL 免去用户手动登录，同时保留后端现有的 JWT 认证链路。桌面端 MUST NOT 复用 `IS_PLATFORM` 的未认证路径。

#### Scenario: 首次启动
- **WHEN** 桌面应用首次启动且后端尚无用户
- **THEN** main 进程生成随机凭据，调用现有注册接口创建桌面用户，并通过 Electron `safeStorage` 加密持久化该凭据

#### Scenario: 后续启动
- **WHEN** 桌面应用再次启动且已存在持久化凭据
- **THEN** main 进程用该凭据调用现有登录接口取得 token，并在页面加载前注入，用户不会看到登录界面

#### Scenario: 凭据失效
- **WHEN** 持久化凭据登录失败
- **THEN** 应用展示现有登录界面，由用户手动处理，而不是绕过认证

#### Scenario: 仅监听回环
- **WHEN** 后端由桌面应用拉起
- **THEN** 后端仅绑定 `127.0.0.1`，同一网络中的其他主机无法访问该端口

#### Scenario: 平台免认证开关不得生效
- **WHEN** main 进程为后端子进程构造环境变量
- **THEN** `VITE_IS_PLATFORM` 被显式剔除，后端的 HTTP 与 WebSocket 认证一律走 JWT 校验，不存在无条件放行的分支

### Requirement: 渲染进程安全隔离
主窗口 SHALL 启用 `contextIsolation`、禁用 `nodeIntegration`，并只通过 preload 暴露白名单 IPC。

#### Scenario: 窗口安全配置
- **WHEN** 创建任一 BrowserWindow
- **THEN** `contextIsolation` 为 true、`nodeIntegration` 为 false，且渲染进程无法访问 Node API 或原始 Electron IPC

#### Scenario: 外部链接
- **WHEN** 页面尝试打开新窗口或导航到非 `http://127.0.0.1:<port>` 与启动页以外的地址
- **THEN** 该导航被拦截，链接改由系统默认浏览器打开

### Requirement: 外部 CLI 的 PATH 解析
桌面应用 SHALL 保证后端子进程能解析到用户 shell 环境中的外部 CLI（`claude`、`codex`、`gemini`、`cursor`），即便应用是从 Finder / 开始菜单等 GUI 入口启动的。

#### Scenario: GUI 启动补全 PATH
- **WHEN** 应用从 GUI 入口启动，进程 `PATH` 为系统极简值
- **THEN** main 进程在 spawn 后端前，将用户登录 shell 的 `PATH` 合并进子进程环境

#### Scenario: CLI 缺失可诊断
- **WHEN** 补全后仍无法解析某个外部 CLI
- **THEN** 该 provider 的失败信息中包含实际使用的 `PATH`，而不是仅报告「命令未找到」

### Requirement: 打包产物可运行
打包后的应用 SHALL 能在目标平台上成功启动后端并完成一次完整会话，原生模块与运行时路径解析均不得因打包方式失效。

#### Scenario: 原生模块 ABI
- **WHEN** 后端子进程在打包产物中启动
- **THEN** `better-sqlite3`（按 Electron ABI 重编）与 `node-pty`（N-API prebuild，未重编）均可被正常加载，数据库读写与终端会话均可用

#### Scenario: 应用根路径解析
- **WHEN** 后端在打包产物中调用 `findAppRoot`
- **THEN** 它解析到实际包含 `package.json`、`dist/`、`dist-server/` 的目录，而不是 asar 内的失效路径

#### Scenario: ripgrep 可执行
- **WHEN** 后端触发基于 `@vscode/ripgrep` 的搜索
- **THEN** ripgrep 二进制位于可执行的解包路径下并正常返回结果
