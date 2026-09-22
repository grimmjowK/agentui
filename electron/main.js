/**
 * CloudCLI 桌面外壳 —— Electron main 进程
 *
 * 职责边界（见 openspec/changes/desktop-electron-shell/design.md）：
 *   - 后端跑独立子进程（D2），以 SERVER_PORT=0 绑 127.0.0.1，通过 stdout 交接端口（D4）
 *   - 窗口在后端就绪前停在本地启动页（D8），就绪后导航到 http://127.0.0.1:<port>
 *   - 免登录走「持久化凭据 + 现有 /api/auth 接口」，绝不复用 IS_PLATFORM 免认证路径（D5）
 *   - GUI 启动时补全 PATH，否则 claude/codex/gemini/cursor 一律找不到（D7）
 */

import { app, BrowserWindow, shell, ipcMain, safeStorage } from 'electron';
import { spawn, exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
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
  const html = `<!doctype html><meta charset="utf-8"><title>CloudCLI</title>
<body style="font:14px/1.6 -apple-system,system-ui,sans-serif;padding:48px;color:#e5e7eb;background:#111827">
<h1 style="font-size:18px;margin:0 0 12px">CloudCLI 无法启动</h1>
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: true,
    backgroundColor: '#111827',
    // 用系统标题栏。hiddenInset 会让网页内容顶到红绿灯下面（图标重叠），且整条顶栏
    // 不可拖拽、双击不缩放 —— 无边框要做对得由前端预留位置并标 -webkit-app-region，
    // 而这套前端同时还要跑在浏览器里，不值得为外壳改动它。
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

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

  app.whenReady().then(async () => {
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
