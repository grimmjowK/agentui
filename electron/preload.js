/**
 * preload —— 只暴露白名单 IPC，渲染进程拿不到 Node API 或原始 ipcRenderer。
 *
 * 启动页与主应用页面（http://127.0.0.1:<port>）共用这一份：启动页用下面的
 * startup-state 接口，主应用页面只依赖这里的 token 注入。
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 免登录 token 注入。
 *
 * 必须在 preload 里做而不是 main 进程 executeJavaScript：preload 是唯一同时满足
 * 「运行在目标 origin 内」和「早于页面任何脚本」的时机。挂 did-start-loading 时
 * 当前文档还是 file:// 启动页，写进去的是另一个 origin 的 localStorage，前端读不到
 * token 后全站 401。
 */
if (location.protocol === 'http:') {
  const token = ipcRenderer.sendSync('cloudcli:take-token');
  if (token) {
    try {
      localStorage.setItem('auth-token', token);
    } catch (err) {
      console.warn('[desktop] token 注入失败，将回落到登录界面:', err.message);
    }
  }
}

contextBridge.exposeInMainWorld('cloudcliDesktop', {
  /** 取当前启动状态（页面刚加载时用，避免错过已经发出的事件） */
  getStartupState: () => ipcRenderer.invoke('cloudcli:get-startup-state'),
  /** 订阅后续状态变更，返回取消订阅函数 */
  onStartupState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('cloudcli:startup-state', listener);
    return () => ipcRenderer.removeListener('cloudcli:startup-state', listener);
  },
  /** 重试：终止残留后端并重新拉起 */
  retry: () => ipcRenderer.invoke('cloudcli:retry'),
  /** 前端主题变化时单向通知外壳，同步原生菜单 / 窗口底色 / Windows 控制按钮 */
  setTheme: (theme) => ipcRenderer.send('cloudcli:set-theme', theme),
});

/**
 * 在 <html> 上写桌面标记，所有桌面样式都以 html[data-desktop] 为作用域（见 src/index.css）。
 *
 * 放在 bridge 之后并整体 try/catch：这里失败只是少了外观，不能连带启动页的重试等 API。
 * preload 执行时根元素可能还没建，用 MutationObserver 等它插入 —— 仍早于任何页面脚本。
 * 每次 document 新建（换页 / 刷新 / 崩溃回启动页）preload 都会重跑，快照随之刷新。
 */
try {
  const state = ipcRenderer.sendSync('cloudcli:get-desktop-state');
  const apply = (root) => {
    root.dataset.desktop = process.platform;
    root.toggleAttribute('data-material', state.material);
    root.toggleAttribute('data-fullscreen', state.fullscreen);
  };

  if (document.documentElement) {
    apply(document.documentElement);
  } else {
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      apply(document.documentElement);
    });
    observer.observe(document, { childList: true });
  }

  ipcRenderer.on('cloudcli:fullscreen', (_event, fullscreen) => {
    state.fullscreen = fullscreen;
    document.documentElement?.toggleAttribute('data-fullscreen', fullscreen);
  });
} catch (err) {
  console.warn('[desktop] 桌面标记初始化失败:', err.message);
}
