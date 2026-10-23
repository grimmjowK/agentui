import { useCallback, useEffect, useRef, useState } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { UseShellRuntimeOptions, UseShellRuntimeResult } from '../types/types';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { useShellConnection } from './useShellConnection';
import { useShellTerminal } from './useShellTerminal';

export function useShellRuntime({
  selectedProject,
  selectedSession,
  initialCommand,
  isPlainShell,
  minimal,
  autoConnect,
  isActive = true,
  isRestarting,
  onProcessComplete,
  onOutputRef,
}: UseShellRuntimeOptions): UseShellRuntimeResult {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [authUrl, setAuthUrl] = useState('');
  const [authUrlVersion, setAuthUrlVersion] = useState(0);

  const selectedProjectRef = useRef(selectedProject);
  const selectedSessionRef = useRef(selectedSession);
  const initialCommandRef = useRef(initialCommand);
  const isPlainShellRef = useRef(isPlainShell);
  const onProcessCompleteRef = useRef(onProcessComplete);
  const authUrlRef = useRef('');
  const lastSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);

  // Keep mutable values in refs so websocket handlers always read current data.
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
    selectedSessionRef.current = selectedSession;
    initialCommandRef.current = initialCommand;
    isPlainShellRef.current = isPlainShell;
    onProcessCompleteRef.current = onProcessComplete;
  }, [selectedProject, selectedSession, initialCommand, isPlainShell, onProcessComplete]);

  const setCurrentAuthUrl = useCallback((nextAuthUrl: string) => {
    authUrlRef.current = nextAuthUrl;
    setAuthUrl(nextAuthUrl);
    setAuthUrlVersion((previous) => previous + 1);
  }, []);

  const closeSocket = useCallback(() => {
    const activeSocket = wsRef.current;
    if (!activeSocket) {
      return;
    }

    if (
      activeSocket.readyState === WebSocket.OPEN ||
      activeSocket.readyState === WebSocket.CONNECTING
    ) {
      activeSocket.close();
    }

    wsRef.current = null;
  }, []);

  const openAuthUrlInBrowser = useCallback((url = authUrlRef.current) => {
    if (!url) {
      return false;
    }

    const popup = window.open(url, '_blank');
    if (popup) {
      try {
        popup.opener = null;
      } catch {
        // Ignore cross-origin restrictions when trying to null opener.
      }
      return true;
    }

    return false;
  }, []);

  const copyAuthUrlToClipboard = useCallback(async (url = authUrlRef.current) => {
    if (!url) {
      return false;
    }

    return copyTextToClipboard(url);
  }, []);

  const { isInitialized, clearTerminalScreen, disposeTerminal } = useShellTerminal({
    terminalContainerRef,
    terminalRef,
    fitAddonRef,
    wsRef,
    selectedProject,
    minimal,
    isRestarting,
    initialCommandRef,
    isPlainShellRef,
    authUrlRef,
    copyAuthUrlToClipboard,
    closeSocket,
  });

  const { isConnected, isConnecting, startupError, connectToShell, disconnectFromShell, releaseForBackground, reconnectForSessionChange } = useShellConnection({
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
    isActive,
    closeSocket,
    clearTerminalScreen,
    setAuthUrl: setCurrentAuthUrl,
    onOutputRef,
  });

  useEffect(() => {
    if (isActive || !isConnected || isPlainShell) {
      return;
    }
    const provider = selectedSession?.__provider || localStorage.getItem('selected-provider');
    if (provider === 'codex') {
      releaseForBackground();
    }
  }, [isActive, isConnected, isPlainShell, releaseForBackground, selectedSession?.__provider]);

  useEffect(() => {
    if (!isRestarting) {
      return;
    }

    disconnectFromShell();
    disposeTerminal();
  }, [disconnectFromShell, disposeTerminal, isRestarting]);

  useEffect(() => {
    if (selectedProject) {
      return;
    }

    disconnectFromShell();
    disposeTerminal();
  }, [disconnectFromShell, disposeTerminal, selectedProject]);

  useEffect(() => {
    const currentSessionId = selectedSession?.id ?? null;
    if (lastSessionIdRef.current !== currentSessionId && isInitialized) {
      reconnectForSessionChange();
    }

    lastSessionIdRef.current = currentSessionId;
  }, [isInitialized, reconnectForSessionChange, selectedSession?.id]);

  return {
    terminalContainerRef,
    terminalRef,
    fitAddonRef,
    wsRef,
    isConnected,
    isInitialized,
    isConnecting,
    startupError,
    authUrl,
    authUrlVersion,
    connectToShell,
    disconnectFromShell,
    openAuthUrlInBrowser,
    copyAuthUrlToClipboard,
  };
}
