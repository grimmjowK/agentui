/**
 * CloudCLI 桌面外壳 —— Electron main 进程
 *
 * 职责边界（见 openspec/changes/desktop-electron-shell/design.md）：
 *   - 后端跑独立子进程（D2），以 SERVER_PORT=0 绑 127.0.0.1，通过 stdout 交接端口（D4）
 *   - 窗口在后端就绪前停在本地启动页（D8），就绪后导航到 http://127.0.0.1:<port>
 *   - 免登录走「持久化凭据 + 现有 /api/auth 接口」，绝不复用 IS_PLATFORM 免认证路径（D5）
 *   - GUI 启动时补全 PATH，否则 claude/codex/agy/cursor 一律找不到（D7）
 */

import { app, BrowserWindow, shell, ipcMain, safeStorage, nativeTheme, screen, Menu, Notification } from 'electron';
import { spawn, exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 后端输出的端口回报前缀，与 server/index.js 的 listen 回调一一对应 */
const PORT_ANNOUNCE_PREFIX = 'CLOUDCLI_LISTENING';
/** 后端启动超时。SQLite 初始化 + 项目扫描在大仓库上可能偏慢，留足余量 */
const BACKEND_READY_TIMEOUT_MS = 60_000;
/** SIGTERM 后的宽限期，超时则 SIGKILL —— 不能让退出流程被后端卡住 */
const BACKEND_KILL_GRACE_MS = 10_000;
const STARTUP_PAGE = path.join(__dirname, 'startup.html');
const PRELOAD_SCRIPT = path.join(__dirname, 'preload.js');

/** 窗口背景色，对应 src/index.css 的 --background（浅 0 0% 100%，深 222.2 84% 4.9%） */
const THEME_BACKGROUND = { light: '#ffffff', dark: '#020817' };
/** Windows 控制按钮图标色，对应 src/index.css 的 --foreground */
const THEME_SYMBOL = { light: '#020817', dark: '#f8fafc' };
/** 与 src/index.css 中 html[data-desktop="win32"] 的 --titlebar-height 一致 */
const WIN_TITLEBAR_HEIGHT = 36;
const DEFAULT_WINDOW_SIZE = { width: 1440, height: 900 };

/**
 * 原生材质（见 desktop-native-polish D3）：macOS vibrancy 全版本可用；
 * Windows 的 backgroundMaterial 需 build ≥ 22621（Win11 22H2），os.release() 形如 10.0.22621。
 */
const USE_MATERIAL = process.platform === 'darwin'
  || (process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621);

// ---------------------------------------------------------------- 全局状态

let mainWindow = null;
/** @type {import('node:child_process').ChildProcess | null} */
let backendProcess = null;
let backendPort = null;
/** 环形缓冲最近的 stderr，用于启动失败时向用户展示原因 */
let backendStderrTail = [];
/** 用户主动退出 / 主动重试时置位，用来区分「预期退出」与「后端崩了」 */
let backendStopping = false;
let isQuitting = false;
/** 启动页状态机：loading | error（就绪后窗口直接导航走，不再有第三态） */
let startupState = { phase: 'loading', message: '正在启动后端服务…', detail: '' };
/** 免登录 token，由 preload 通过同步 IPC 取走写进目标 origin 的 localStorage */
let desktopToken = null;

// ---------------------------------------------------------------- 路径解析

/**
 * 解析后端入口。
 *
 * 打包产物按 D6 把 dist-server/ 整棵放在 resources/app/ 下（不进 asar），
 * 这样 server/utils/runtime-paths.js 的 findAppRoot 向上查找逻辑原样成立。
 */
function resolveBackendEntry() {
  const packaged = path.join(process.resourcesPath ?? '', 'app', 'dist-server', 'server', 'index.js');
  if (app.isPackaged) return packaged;

  // 开发态：electron/ 的上一级就是仓库根
  return path.join(__dirname, '..', 'dist-server', 'server', 'index.js');
}

// ---------------------------------------------------------------- PATH 补全

let cachedShellPath = null;

/**
 * 从用户登录 shell 里取一次 PATH 并缓存。
 *
 * macOS 从 Finder 启动的应用只继承 /usr/bin:/bin:/usr/sbin:/sbin，装在 ~/.local/bin、
 * nvm、homebrew 下的 CLI 一律解析不到 —— 且现象极具误导性（用户终端里明明能跑）。
 * Windows 无此问题，直接跳过。
 */
async function resolveShellPath() {
  if (cachedShellPath !== null) return cachedShellPath;
  if (process.platform === 'win32') {
    cachedShellPath = process.env.PATH ?? '';
    return cachedShellPath;
  }

  const loginShell = process.env.SHELL || '/bin/bash';
  cachedShellPath = await new Promise((resolve) => {
    // -ilc: 交互式登录 shell，才能吃到 ~/.zshrc、~/.bash_profile 里的 PATH 追加
    exec(`${loginShell} -ilc 'echo "$PATH"'`, { timeout: 5_000 }, (err, stdout) => {
      if (err || !stdout?.trim()) {
        // 非常规 shell（fish、rc 里有交互式输出等）会走到这里，退回当前 PATH 而不是报错
        console.warn('[desktop] 登录 shell PATH 解析失败，回退到进程 PATH:', err?.message ?? '空输出');
        resolve(process.env.PATH ?? '');
        return;
      }
      // 交互式 rc 可能打印额外内容，只取最后一行非空输出
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      resolve(lines[lines.length - 1] ?? process.env.PATH ?? '');
    });
  });

  return cachedShellPath;
}

/** 合并登录 shell PATH 与当前 PATH，去重后保持先后顺序 */
function mergePath(shellPath) {
  const seen = new Set();
  return [shellPath, process.env.PATH ?? '']
    .filter(Boolean)
    .join(path.delimiter)
    .split(path.delimiter)
    .filter((entry) => entry && !seen.has(entry) && seen.add(entry))
    .join(path.delimiter);
}

// ---------------------------------------------------------------- 启动页状态

function setStartupState(phase, message, detail = '') {
  startupState = { phase, message, detail };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('cloudcli:startup-state', startupState);
  }
}

/**
 * 启动页自身的资源都加载不出来时的最后兜底。
 * 这个文档内联在 main 进程里，不依赖 preload、不依赖磁盘文件。
 */
function inlineFailureDocument(message) {
  const html = `<!doctype html><meta charset="utf-8"><title>EAO</title>
<body style="font:14px/1.6 -apple-system,system-ui,sans-serif;padding:48px;color:#e5e7eb;background:#111827">
<h1 style="font-size:18px;margin:0 0 12px">EAO 无法启动</h1>
<pre style="white-space:pre-wrap;color:#fca5a5">${String(message).replace(/[<&]/g, (ch) => (ch === '<' ? '&lt;' : '&amp;'))}</pre>
<p style="color:#9ca3af">请退出应用后重新启动。若问题持续，请从终端运行 <code>npx cloudcli</code> 查看完整日志。</p>
</body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function showStartupPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    await mainWindow.loadFile(STARTUP_PAGE);
  } catch (err) {
    await mainWindow.loadURL(inlineFailureDocument(`启动页加载失败：${err.message}`));
  }
}

// ---------------------------------------------------------------- 后端子进程

/** 终止后端子进程；SIGTERM 宽限期后仍在则 SIGKILL。总是 resolve，不阻塞退出流程。 */
function stopBackend() {
  const child = backendProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    backendProcess = null;
    return Promise.resolve();
  }

  backendStopping = true;
  backendProcess = null;

  return new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve();
    }, BACKEND_KILL_GRACE_MS);

    child.once('close', () => {
      clearTimeout(killTimer);
      resolve();
    });

    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(killTimer);
      resolve();
    }
  });
}

/**
 * 拉起后端子进程并等待它回报端口。
 * @returns {Promise<number>} 实际监听端口
 */
async function startBackend() {
  const entry = resolveBackendEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(`后端入口不存在：${entry}\n请先执行 npm run build。`);
  }

  const shellPath = await resolveShellPath();
  const mergedPath = mergePath(shellPath);

  // 构造子进程环境。注意这里对 VITE_IS_PLATFORM 的处理是安全约束而非清理：
  // server/middleware/auth.js 在 IS_PLATFORM 为 true 时对 HTTP 与 WebSocket 均无条件放行，
  // 而后端具备 spawn 外部 CLI 与 pty 的能力 —— 桌面端绝不能让这个开关生效（见 D5）。
  const env = { ...process.env, PATH: mergedPath };
  delete env.VITE_IS_PLATFORM;
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1',
    HOST: '127.0.0.1',
    SERVER_PORT: '0',
    NODE_ENV: app.isPackaged ? 'production' : env.NODE_ENV ?? 'development',
  });

  backendStderrTail = [];
  backendStopping = false;

  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..'),
  });
  backendProcess = child;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    backendStderrTail.push(chunk);
    if (backendStderrTail.length > 40) backendStderrTail.shift();
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      fn(arg);
    };

    const timeoutTimer = setTimeout(() => {
      finish(reject, new Error(`后端在 ${BACKEND_READY_TIMEOUT_MS / 1000} 秒内未就绪，已终止。`));
      stopBackend();
    }, BACKEND_READY_TIMEOUT_MS);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      process.stdout.write(`${line}\n`);
      if (!line.startsWith(PORT_ANNOUNCE_PREFIX)) return;
      try {
        const { port } = JSON.parse(line.slice(PORT_ANNOUNCE_PREFIX.length).trim());
        if (typeof port === 'number') finish(resolve, port);
      } catch (err) {
        console.warn('[desktop] 端口回报行解析失败:', line, err.message);
      }
    });

    child.once('error', (err) => finish(reject, err));

    child.once('close', (code, signal) => {
      const reason = `后端进程退出 (code=${code}, signal=${signal})`;
      finish(reject, new Error(`${reason}\n${backendStderrTail.join('')}`));
      // 已就绪之后的非预期退出：回启动页展示错误，而不是留着一个连不上后端的白页
      if (settled && !backendStopping && !isQuitting) {
        handleBackendCrash(reason);
      }
    });
  });
}

async function handleBackendCrash(reason) {
  backendProcess = null;
  backendPort = null;
  await showStartupPage();
  setStartupState('error', '后端服务意外退出', `${reason}\n\n${backendStderrTail.join('')}`.trim());
}

// ---------------------------------------------------------------- 免登录凭据

function credentialsFile() {
  return path.join(app.getPath('userData'), 'desktop-credentials.bin');
}

function loadCredentials() {
  const file = credentialsFile();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
  } catch (err) {
    console.warn('[desktop] 凭据解密失败，将重新走注册流程:', err.message);
    return null;
  }
}

function saveCredentials(credentials) {
  fs.writeFileSync(credentialsFile(), safeStorage.encryptString(JSON.stringify(credentials)), { mode: 0o600 });
}

async function postJson(port, route, body) {
  const resp = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, data };
}

/**
 * 取得桌面用户的 JWT。
 *
 * 认证链路一行不改：首次生成随机凭据走现有 /api/auth/register，之后走 /api/auth/login。
 * 任何一步失败都返回 null —— 由现有登录界面接管，绝不尝试绕过认证。
 */
async function acquireToken(port) {
  if (!safeStorage.isEncryptionAvailable()) {
    // 明确报错而非静默降级成明文存盘：这份凭据能换到一个可 spawn 任意 CLI 的后端 token
    throw new Error('系统密钥环不可用，无法安全存储桌面凭据。请在系统设置中启用密钥环后重试。');
  }

  const existing = loadCredentials();
  if (existing) {
    const { ok, data } = await postJson(port, '/api/auth/login', existing);
    if (ok && data.token) return data.token;
    console.warn('[desktop] 已存凭据登录失败，交回登录界面:', data.error ?? '未知错误');
    return null;
  }

  const credentials = {
    username: 'cloudcli-desktop',
    password: crypto.randomBytes(32).toString('base64url'),
  };
  const { ok, data } = await postJson(port, '/api/auth/register', credentials);
  if (ok && data.token) {
    saveCredentials(credentials);
    return data.token;
  }

  // 用户此前已通过 Web 端建过账号时，注册会因单用户校验返回 403 —— 这是预期分支
  console.warn('[desktop] 自动注册未成功，交回登录界面:', data.error ?? '未知错误');
  return null;
}

// ---------------------------------------------------------------- 窗口

function isAllowedNavigation(targetUrl) {
  if (targetUrl.startsWith('file://')) return true;
  if (targetUrl.startsWith('data:text/html')) return true;
  if (!backendPort) return false;
  try {
    const { protocol, hostname, port } = new URL(targetUrl);
    return protocol === 'http:' && hostname === '127.0.0.1' && port === String(backendPort);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 窗口状态（D7）

/** { x, y, width, height, isMaximized, theme }；文件不存在或损坏时走默认值 */
let windowState = {};

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveWindowState() {
  try {
    fs.writeFileSync(windowStateFile(), JSON.stringify(windowState));
  } catch (err) {
    console.warn('[desktop] 窗口状态保存失败:', err.message);
  }
}

/** 上次位置不与任何显示器 workArea 相交（如外接屏已拔）时丢弃位置，只留尺寸，由 BrowserWindow 默认居中 */
function restoreBounds({ x, y, width = DEFAULT_WINDOW_SIZE.width, height = DEFAULT_WINDOW_SIZE.height }) {
  const size = { width, height };
  if (!Number.isFinite(x) || !Number.isFinite(y)) return size;
  const visible = screen.getAllDisplays().some(({ workArea: a }) => (
    x < a.x + a.width && x + width > a.x && y < a.y + a.height && y + height > a.y
  ));
  return visible ? { x, y, ...size } : size;
}

/** 材质启用时 overlay 用透明底，让 mica 透出来，避免控制按钮区出现色块 */
function titleBarOverlay(theme) {
  return {
    color: USE_MATERIAL ? '#00000000' : THEME_BACKGROUND[theme],
    symbolColor: THEME_SYMBOL[theme],
    height: WIN_TITLEBAR_HEIGHT,
  };
}

function currentTheme() {
  return windowState.theme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
}

// ---------------------------------------------------------------- 菜单（D6）

function buildApplicationMenu() {
  const viewSubmenu = [
    { role: 'reload' },
    { role: 'forceReload' },
    ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  const template = process.platform === 'darwin'
    ? [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu', submenu: viewSubmenu }, { role: 'windowMenu' }]
    : [{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu', submenu: viewSubmenu }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 只在可编辑元素或有选中文本时弹；页面自己 preventDefault 的 contextmenu 不会走到这里 */
function showContextMenu(win, params) {
  const { isEditable, selectionText, editFlags, misspelledWord, dictionarySuggestions } = params;
  const hasSelection = selectionText.trim().length > 0;
  if (!isEditable && !hasSelection) return;

  const template = [];
  if (isEditable && misspelledWord && dictionarySuggestions.length > 0) {
    for (const suggestion of dictionarySuggestions) {
      template.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) });
    }
    template.push({ type: 'separator' });
  }
  if (isEditable) {
    template.push(
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags.canSelectAll },
    );
  } else {
    template.push({ role: 'copy', enabled: editFlags.canCopy });
  }
  Menu.buildFromTemplate(template).popup({ window: win });
}

function createWindow() {
  const savedTheme = windowState.theme;
  // 建窗前套用上次主题，启动页的 prefers-color-scheme 与原生控件随之一致；首次启动保持 'system'
  if (savedTheme) nativeTheme.themeSource = savedTheme;
  const theme = currentTheme();

  const platformChrome = process.platform === 'darwin'
    ? {
      titleBarStyle: 'hiddenInset',
      // 红绿灯（约 14px 高）垂直居中于 38px 拖拽条；实机偏差在这里微调
      trafficLightPosition: { x: 14, y: 12 },
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
    }
    : {
      titleBarStyle: 'hidden',
      titleBarOverlay: titleBarOverlay(theme),
      ...(USE_MATERIAL ? { backgroundMaterial: 'mica' } : {}),
    };

  mainWindow = new BrowserWindow({
    ...restoreBounds(windowState),
    // > 前端 768 移动端断点（src/hooks/useDeviceSettings.ts），100% 缩放下不落入抽屉布局
    minWidth: 960,
    minHeight: 480,
    show: false,
    // 材质画在窗口背后，背景必须透明才看得见；否则用主题底色防止首帧异色
    backgroundColor: USE_MATERIAL ? '#00000000' : THEME_BACKGROUND[theme],
    ...platformChrome,
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (windowState.isMaximized) mainWindow.maximize();
    mainWindow.show();
  });

  // getNormalBounds：最大化时存还原尺寸，而不是整屏
  mainWindow.on('close', () => {
    Object.assign(windowState, mainWindow.getNormalBounds(), { isMaximized: mainWindow.isMaximized() });
    saveWindowState();
  });

  // 回到前台即视为已看到：清角标、停闪烁
  mainWindow.on('focus', () => {
    attentionCount = 0;
    app.setBadgeCount(0);
    mainWindow.flashFrame(false);
  });

  for (const [event, fullscreen] of [['enter-full-screen', true], ['leave-full-screen', false]]) {
    mainWindow.on(event, () => mainWindow.webContents.send('cloudcli:fullscreen', fullscreen));
  }

  // 禁用触控板捏合缩放；Cmd/Ctrl +/-/0 走 View 菜单的 zoom 角色，保留
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
  mainWindow.webContents.on('context-menu', (_event, params) => showContextMenu(mainWindow, params));

  // 站外地址一律交给系统浏览器，不在应用内开窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 启动（或重启）后端，就绪后注入 token 并导航到应用 */
async function bootBackendAndNavigate() {
  setStartupState('loading', '正在启动后端服务…');

  try {
    backendPort = await startBackend();
  } catch (err) {
    backendPort = null;
    setStartupState('error', '后端服务启动失败', err.message);
    return;
  }

  let token = null;
  try {
    token = await acquireToken(backendPort);
  } catch (err) {
    // safeStorage 不可用属于硬失败：报错而不是退化成明文存储
    setStartupState('error', '桌面凭据不可用', err.message);
    return;
  }

  // 交给 preload 注入（见 preload.js）。不能在这里 executeJavaScript：
  // 无论挂 did-start-loading 还是 did-navigate，脚本要么跑在旧文档（file:// 启动页，
  // localStorage 是另一个 origin 的，前端读不到 → 全站 401），要么已经晚于前端的
  // AuthContext 初始化。preload 天然满足「目标 origin + 页面脚本之前」两个条件。
  desktopToken = token;

  await mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('cloudcli:get-startup-state', () => startupState);

// 同步 handler：preload 必须在页面脚本前拿到 token，不能 await
ipcMain.on('cloudcli:take-token', (event) => {
  event.returnValue = desktopToken;
});

ipcMain.handle('cloudcli:retry', async () => {
  await stopBackend();
  await showStartupPage();
  await bootBackendAndNavigate();
});

// 同步 handler：preload 要在页面首帧前把 data-material / data-fullscreen 写上 <html>（D1）
ipcMain.on('cloudcli:get-desktop-state', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  event.returnValue = { material: USE_MATERIAL, fullscreen: win?.isFullScreen() ?? false };
});

// ---------------------------------------------------------------- 后台提醒

/** 窗口失焦期间累计的待处理请求数，用作 Dock 角标 */
let attentionCount = 0;
/** 持有通知引用：被 GC 后 macOS 上点击回调会丢失 */
const liveNotifications = new Set();

/**
 * 审批 / 交互问答到达时由前端调用。窗口在前台时什么都不做（页面内卡片已可见）；
 * 在后台时发系统通知 + Dock 跳动 / 任务栏闪烁，点击通知回到窗口并切到对应 session。
 */
ipcMain.on('cloudcli:attention', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isFocused()) return;
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const title = text(payload?.title, 80) || 'EAO';
  const body = text(payload?.body, 200);
  const sessionId = text(payload?.sessionId, 200) || null;
  const provider = text(payload?.provider, 40) || null;

  attentionCount += 1;
  app.setBadgeCount(attentionCount); // Windows 不支持角标，返回 false，靠 flashFrame
  if (process.platform === 'darwin') app.dock.bounce('critical');
  else win.flashFrame(true);

  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  liveNotifications.add(notification);
  const release = () => liveNotifications.delete(notification);
  notification.on('close', release);
  notification.on('click', () => {
    release();
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('cloudcli:open-session', { sessionId, provider });
  });
  notification.show();
});

// 前端是主题唯一真相，这里只单向跟随（D4）
ipcMain.on('cloudcli:set-theme', (event, theme) => {
  if (theme !== 'light' && theme !== 'dark') return;
  nativeTheme.themeSource = theme;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (!USE_MATERIAL) win.setBackgroundColor(THEME_BACKGROUND[theme]);
    if (process.platform === 'win32') win.setTitleBarOverlay(titleBarOverlay(theme));
  }
  if (windowState.theme !== theme) {
    windowState.theme = theme;
    saveWindowState();
  }
});

// ---------------------------------------------------------------- 生命周期

// 单实例：两个后端同时操作同一份 SQLite 与 ~/.claude 会互相踩踏
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // Windows 通知需要与安装器快捷方式一致的 AUMID（electron-builder.config.js 的 appId）
  if (process.platform === 'win32') app.setAppUserModelId('ai.cloudcli.desktop');

  app.whenReady().then(async () => {
    windowState = loadWindowState();
    buildApplicationMenu();
    if (!app.isPackaged && process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, '..', 'public', 'logo-1024.png'));
    createWindow();
    await showStartupPage();
    await bootBackendAndNavigate();
  });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    createWindow();
    if (backendPort) {
      await mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);
    } else {
      await showStartupPage();
      await bootBackendAndNavigate();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // 退出前必须先回收后端，否则留下孤儿进程持有 SQLite 与 pty
  app.on('before-quit', async (event) => {
    if (isQuitting) return;
    isQuitting = true;
    event.preventDefault();
    await stopBackend();
    app.quit();
  });
}
