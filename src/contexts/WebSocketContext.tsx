import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

// 1006 = abnormal close (network error or server rejected handshake)
// consecutive failures at this code → auth problem, back off
const AUTH_FAILURE_CLOSE_CODE = 1006;
const MAX_AUTH_RETRIES = 3;
const RECONNECT_DELAY_MS = 3000;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => boolean;
  latestMessage: any | null;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const consecutiveFailuresRef = useRef(0);
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { token } = useAuth();

  useEffect(() => {
    unmountedRef.current = false;
    consecutiveFailuresRef.current = 0;
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [token]); // everytime token changes, we reconnect

  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    try {
      const wsUrl = buildWebSocketUrl(token);
      if (!wsUrl) {
        console.warn('No authentication token found for WebSocket connection');
        return;
      }

      const websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        consecutiveFailuresRef.current = 0;
        setIsConnected(true);
        wsRef.current = websocket;
        if (hasConnectedRef.current) {
          setLatestMessage({ type: 'websocket-reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setLatestMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = (event) => {
        setIsConnected(false);
        wsRef.current = null;

        if (unmountedRef.current) return;

        // When the server rejects the handshake (auth failure), the browser
        // always delivers code 1006. After MAX_AUTH_RETRIES consecutive 1006s
        // without a successful open in between, stop retrying so we don't loop.
        if (event.code === AUTH_FAILURE_CLOSE_CODE) {
          consecutiveFailuresRef.current += 1;
          if (consecutiveFailuresRef.current >= MAX_AUTH_RETRIES) {
            console.warn(
              `WebSocket: ${consecutiveFailuresRef.current} consecutive connection failures — pausing reconnect. Check server status or re-login.`
            );
            // Still try once more after a longer delay in case it's a server restart
            reconnectTimeoutRef.current = setTimeout(() => {
              if (unmountedRef.current) return;
              consecutiveFailuresRef.current = 0;
              connect();
            }, RECONNECT_DELAY_MS * 5);
            return;
          }
        }

        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return;
          connect();
        }, RECONNECT_DELAY_MS);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [token]);

  const sendMessage = useCallback((message: any): boolean => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    } else {
      console.warn('WebSocket not connected');
      return false;
    }
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    isConnected
  }), [sendMessage, latestMessage, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
