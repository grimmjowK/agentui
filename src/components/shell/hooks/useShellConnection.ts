import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { Project, ProjectSession } from '../../../types/app';
import { TERMINAL_INIT_DELAY_MS } from '../constants/constants';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '../utils/socket';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

type UseShellConnectionOptions = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  isActive?: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  setAuthUrl: (nextAuthUrl: string) => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  startupError: string | null;
  closeSocket: () => void;
  connectToShell: () => void;
  disconnectFromShell: () => void;
  releaseForBackground: () => void;
  reconnectForSessionChange: () => void;
};

export function useShellConnection({
  wsRef,
  terminalRef,
  fitAddonRef,
  selectedProjectRef,
  selectedSessionRef,
  initialCommandRef,
  isPlainShellRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  isActive = true,
  closeSocket,
  clearTerminalScreen,
  setAuthUrl,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const connectingRef = useRef(false);
  const disconnectRequested = useRef(false);
  const pendingReconnect = useRef(false);
  const terminalStopped = useRef(false);

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'runtime') {
        terminalRef.current?.writeln(`Codex ${String(message.version)} · ${String(message.executablePath)} · ${String(message.configRoot)}`);
        return;
      }
      if (message.type === 'session_released') {
        if (message.provider === 'codex' && message.sessionId) window.dispatchEvent(new CustomEvent('codex-session-released', { detail: { sessionId: message.sessionId } }));
        if (message.provider === 'codex' || disconnectRequested.current) {
          const shouldReconnect = pendingReconnect.current;
          pendingReconnect.current = false;
          if (shouldReconnect) {
            terminalStopped.current = false;
          }
          disconnectRequested.current = false;
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          closeSocket();
          if (shouldReconnect) {
            clearTerminalScreen();
          }
        }
        return;
      }
      if (message.type === 'error') {
        const errorText = String(message.message ?? '');
        terminalRef.current?.writeln(`Error: ${errorText}`);
        if (message.startupFailed) {
          pendingReconnect.current = false;
          terminalStopped.current = true;
          setStartupError(errorText);
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          closeSocket();
        }
        return;
      }
      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'auth_url' || message.type === 'url_open') {
        const nextAuthUrl = typeof message.url === 'string' ? message.url : '';
        if (nextAuthUrl) {
          setAuthUrl(nextAuthUrl);
        }
      }
    },
    [clearTerminalScreen, closeSocket, handleProcessCompletion, onOutputRef, setAuthUrl, terminalRef],
  );

  const connectWebSocket = useCallback(
    () => {
      try {
        const wsUrl = getShellWebSocketUrl();
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          return;
        }

        connectingRef.current = true;
        setIsConnecting(true);

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (wsRef.current && wsRef.current !== socket) {
            return;
          }
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;
          setAuthUrl('');

          window.setTimeout(() => {
            if (wsRef.current && wsRef.current !== socket) {
              return;
            }
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            if (!currentTerminal || !currentFitAddon || !currentProject) {
              return;
            }

            currentFitAddon.fit();

            sendSocketMessage(socket, {
              type: 'init',
              projectPath: currentProject.fullPath || currentProject.path || '',
              sessionId: isPlainShellRef.current ? null : selectedSessionRef.current?.id || null,
              hasSession: isPlainShellRef.current ? false : Boolean(selectedSessionRef.current),
              provider: isPlainShellRef.current ? 'plain-shell' : (selectedSessionRef.current?.__provider || localStorage.getItem('selected-provider') || 'claude'),
              model: localStorage.getItem('codex-model') || undefined,
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          if (wsRef.current && wsRef.current !== socket) {
            return;
          }
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          if (wsRef.current && wsRef.current !== socket) {
            return;
          }
          const shouldReconnect = pendingReconnect.current;
          if (shouldReconnect) {
            pendingReconnect.current = false;
            disconnectRequested.current = false;
            terminalStopped.current = false;
          }
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          if (!terminalStopped.current) clearTerminalScreen();
        };

        socket.onerror = () => {
          if (wsRef.current && wsRef.current !== socket) {
            return;
          }
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
        };
      } catch {
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
      }
    },
    [
      clearTerminalScreen,
      fitAddonRef,
      handleSocketMessage,
      initialCommandRef,
      isPlainShellRef,
      selectedProjectRef,
      selectedSessionRef,
      setAuthUrl,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback(() => {
    if (!isInitialized) {
      return;
    }
    const activeSocket = wsRef.current;
    if (
      !disconnectRequested.current &&
      activeSocket &&
      (activeSocket.readyState === WebSocket.OPEN || activeSocket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    if (activeSocket) {
      closeSocket();
    }
    disconnectRequested.current = false;
    terminalStopped.current = false;
    pendingReconnect.current = false;
    setStartupError(null);
    connectWebSocket();
  }, [closeSocket, connectWebSocket, isInitialized, wsRef]);

  const notifyCodexSessionReleased = useCallback(() => {
    const currentSession = selectedSessionRef.current;
    if (!currentSession?.id) {
      return;
    }
    const provider = currentSession.__provider || localStorage.getItem('selected-provider') || 'claude';
    if (provider === 'codex') {
      const sessionId = currentSession.id;
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('codex-session-released', { detail: { sessionId } }));
      }, 300);
    }
  }, [selectedSessionRef]);

  const disconnectFromShell = useCallback(() => {
    pendingReconnect.current = false;
    terminalStopped.current = true;
    if (wsRef.current) {
      sendSocketMessage(wsRef.current, { type: 'terminate' });
      notifyCodexSessionReleased();
    }
    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    connectingRef.current = false;
    disconnectRequested.current = false;
    setAuthUrl('');
  }, [clearTerminalScreen, closeSocket, notifyCodexSessionReleased, setAuthUrl, wsRef]);

  /**
   * 离开「终端」切回「聊天」Tab 时自动释放后台终端进程，但不标记为手动停止（切回终端 Tab 时仍自动重连）。
   */
  const releaseForBackground = useCallback(() => {
    pendingReconnect.current = false;
    terminalStopped.current = false;
    if (wsRef.current) {
      sendSocketMessage(wsRef.current, { type: 'terminate' });
      notifyCodexSessionReleased();
    }
    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    connectingRef.current = false;
    disconnectRequested.current = false;
    setAuthUrl('');
  }, [clearTerminalScreen, closeSocket, notifyCodexSessionReleased, setAuthUrl, wsRef]);

  const reconnectForSessionChange = useCallback(() => {
    setStartupError(null);
    terminalStopped.current = false;
    pendingReconnect.current = false;
    disconnectRequested.current = false;
    const activeSocket = wsRef.current;
    if (activeSocket && (activeSocket.readyState === WebSocket.OPEN || activeSocket.readyState === WebSocket.CONNECTING)) {
      sendSocketMessage(activeSocket, { type: 'terminate' });
    }
    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    connectingRef.current = false;
    setAuthUrl('');
  }, [clearTerminalScreen, closeSocket, setAuthUrl, wsRef]);

  useEffect(() => {
    if (!isActive || terminalStopped.current || !autoConnect || !isInitialized || isConnecting || isConnected) {
      return;
    }

    connectToShell();
  }, [autoConnect, connectToShell, isActive, isConnected, isConnecting, isInitialized]);

  return {
    isConnected,
    isConnecting,
    startupError,
    closeSocket,
    connectToShell,
    disconnectFromShell,
    releaseForBackground,
    reconnectForSessionChange,
  };
}
