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
});
