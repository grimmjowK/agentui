export {};

declare global {
  interface Window {
    __ROUTER_BASENAME__?: string;
    /** Electron 外壳 preload 暴露的 bridge，浏览器端不存在（见 electron/preload.js） */
    cloudcliDesktop?: {
      setTheme: (theme: 'light' | 'dark') => void;
      notifyAttention: (payload: { title: string; body: string; sessionId: string | null; provider: string | null }) => void;
      onOpenSession: (callback: (target: { sessionId: string | null; provider: string | null }) => void) => () => void;
    };
  }

  interface EventSourceEventMap {
    result: MessageEvent;
    progress: MessageEvent;
    done: MessageEvent;
  }
}
