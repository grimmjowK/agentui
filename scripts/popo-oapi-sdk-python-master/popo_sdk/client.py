"""POPO WebSocket 长链接客户端"""

import logging
import random
import threading
import time
import uuid
from enum import Enum
from typing import Optional

import websocket

from .auth import TokenManager
from .dispatcher import EventDispatcher
from .message import MessageHandler
from .stomp import (
    StompCommand,
    StompFrame,
    build_connect_frame,
    build_disconnect_frame,
    build_heartbeat_frame,
    build_subscribe_frame,
)

logger = logging.getLogger("popo_sdk.client")

# 默认配置
_DEFAULT_MERCURY_URL = "wss://nws.popo.netease.com:11012"
_DEFAULT_BASE_URL = "https://open.popo.netease.com"
_DEFAULT_HEARTBEAT_INTERVAL_MS = 10000
_DEFAULT_MESSAGE_EXPIRATION_MS = 30 * 60 * 1000
_DEFAULT_DESTINATION_PREFIX = "/robots/msg/OpenClaw"

# 重连参数
_BASE_RETRY_DELAY_MS = 1000
_MAX_RETRY_DELAY_MS = 60000


class ClientState(Enum):
    IDLE = "IDLE"
    CONNECTING = "CONNECTING"
    CONNECTED = "CONNECTED"
    CLOSING = "CLOSING"
    CLOSED = "CLOSED"


class PopoWsClient:
    """
    POPO 长链接客户端
    
    使用方法：
        from popo_sdk import PopoWsClient, EventDispatcher
        
        dispatcher = EventDispatcher()
        
        @dispatcher.on_p2p_message
        def handle(event):
            print(event.event_data.notify)
        
        client = PopoWsClient(
            app_key="xxx",
            app_secret="yyy",
            aes_key="zzz",
            event_dispatcher=dispatcher,
        )
        
        # 阻塞运行
        client.start()
        
        # 或后台运行
        client.start_background()
    """

    def __init__(
        self,
        app_key: str,
        app_secret: str,
        event_dispatcher: EventDispatcher,
        aes_key: Optional[str] = None,
        mercury_url: str = _DEFAULT_MERCURY_URL,
        base_url: str = _DEFAULT_BASE_URL,
        heartbeat_interval_ms: int = _DEFAULT_HEARTBEAT_INTERVAL_MS,
        message_expiration_ms: int = _DEFAULT_MESSAGE_EXPIRATION_MS,
        destination_prefix: str = _DEFAULT_DESTINATION_PREFIX,
    ):
        if not app_key:
            raise ValueError("app_key is required")
        if not app_secret:
            raise ValueError("app_secret is required")
        if not event_dispatcher:
            raise ValueError("event_dispatcher is required")

        self._app_key = app_key
        self._app_secret = app_secret
        self._aes_key = aes_key
        self._mercury_url = mercury_url
        self._base_url = base_url
        self._heartbeat_interval_ms = heartbeat_interval_ms
        self._destination_prefix = destination_prefix

        self._token_manager = TokenManager(app_key, app_secret, base_url)
        self._message_handler = MessageHandler(event_dispatcher, aes_key, message_expiration_ms)

        self._state = ClientState.IDLE
        self._ws: Optional[websocket.WebSocketApp] = None
        self._robot_uid = ""
        self._subscription_id = ""
        self._retry_count = 0
        self._heartbeat_timer: Optional[threading.Timer] = None
        self._stop_event = threading.Event()
        self._bg_thread: Optional[threading.Thread] = None

    @property
    def state(self) -> ClientState:
        return self._state

    # ========== 启动 ==========

    def start(self):
        """阻塞式启动（适合独立脚本）"""
        if self._state not in (ClientState.IDLE, ClientState.CLOSED):
            logger.warning(f"[POPO-WS] Client already started, state: {self._state}")
            return

        logger.info("[POPO-WS] Starting POPO WebSocket client...")
        self._state = ClientState.CONNECTING
        self._retry_count = 0
        self._stop_event.clear()

        # 连接循环（断线重连在这里控制）
        while not self._stop_event.is_set():
            try:
                self._connect()
            except Exception:
                logger.exception("[POPO-WS] Connection error")

            if self._stop_event.is_set():
                break

            # 重连等待
            self._schedule_reconnect_wait()

        self._state = ClientState.CLOSED
        logger.info("[POPO-WS] Client stopped")

    def start_background(self):
        """后台线程启动（适合 Web 框架集成）"""
        if self._state not in (ClientState.IDLE, ClientState.CLOSED):
            logger.warning(f"[POPO-WS] Client already started, state: {self._state}")
            return

        self._bg_thread = threading.Thread(target=self.start, daemon=True, name="popo-ws-main")
        self._bg_thread.start()

    def close(self):
        """优雅关闭"""
        if self._state in (ClientState.CLOSING, ClientState.CLOSED):
            return

        logger.info("[POPO-WS] Closing POPO WebSocket client...")
        self._state = ClientState.CLOSING
        self._stop_event.set()

        self._stop_heartbeat()

        # 发送 DISCONNECT 并关闭 WS
        if self._ws:
            try:
                self._ws.send(build_disconnect_frame().serialize())
            except Exception:
                pass
            try:
                self._ws.close()
            except Exception:
                pass
            self._ws = None

        self._state = ClientState.CLOSED
        logger.info("[POPO-WS] Client closed")

    # ========== 内部连接逻辑 ==========

    def _connect(self):
        """建立一次 WebSocket 连接"""
        try:
            # 获取 OnceToken
            once_token, robot_uid = self._token_manager.get_once_token()
            self._robot_uid = robot_uid

            # 构建 WebSocket URL
            ws_url = (
                f"{self._mercury_url}/stomp"
                f"?auth_type=ROBOT_ONCE_TOKEN"
                f"&auth_token={once_token}"
                f"&app_id=popo"
            )

            logger.info(f"[POPO-WS] Connecting to {self._mercury_url} (robotUid={robot_uid})")
            self._state = ClientState.CONNECTING

            # 创建 WebSocketApp
            self._ws = websocket.WebSocketApp(
                ws_url,
                on_open=self._on_open,
                on_message=self._on_message,
                on_close=self._on_close,
                on_error=self._on_error,
            )

            # run_forever 阻塞直到连接关闭
            import ssl
            self._ws.run_forever(
                ping_interval=0,  # 我们自己管理心跳
                ping_timeout=None,
                sslopt={"cert_reqs": ssl.CERT_NONE},
            )

        except Exception:
            logger.exception("[POPO-WS] Connection failed")
            raise

    def _schedule_reconnect_wait(self):
        """断线后等待重连"""
        if self._stop_event.is_set():
            return

        self._state = ClientState.CONNECTING
        count = self._retry_count
        self._retry_count += 1

        # 指数退避: min(1000 * 2^n, 60000) * jitter(0.8~1.2)
        delay_ms = min(_BASE_RETRY_DELAY_MS * (2 ** count), _MAX_RETRY_DELAY_MS)
        delay_ms = int(delay_ms * (0.8 + random.random() * 0.4))
        delay_s = delay_ms / 1000.0

        logger.info(f"[POPO-WS] Reconnecting in {delay_ms}ms (attempt {count + 1})")
        self._stop_event.wait(delay_s)

    # ========== WebSocket 回调 ==========

    def _on_open(self, ws):
        logger.info("[POPO-WS] WebSocket connected, sending STOMP CONNECT...")
        frame = build_connect_frame(self._heartbeat_interval_ms)
        ws.send(frame.serialize())

    def _on_message(self, ws, message):
        if isinstance(message, bytes):
            message = message.decode("utf-8", errors="replace")
        frames = StompFrame.parse(message)
        for frame in frames:
            self._handle_stomp_frame(ws, frame)

    def _on_close(self, ws, close_status_code, close_msg):
        logger.info(f"[POPO-WS] WebSocket closed: code={close_status_code}, msg={close_msg}")
        self._stop_heartbeat()

    def _on_error(self, ws, error):
        logger.warning(f"[POPO-WS] WebSocket error: {error}")
        self._stop_heartbeat()

    # ========== STOMP 帧处理 ==========

    def _handle_stomp_frame(self, ws, frame: StompFrame):
        if frame.command == StompCommand.CONNECTED:
            self._handle_connected(ws, frame)
        elif frame.command == StompCommand.MESSAGE:
            self._handle_message(frame)
        elif frame.command == StompCommand.ERROR:
            self._handle_error(ws, frame)
        else:
            logger.debug(f"[POPO-WS] Received STOMP frame: {frame.command}")

    def _handle_connected(self, ws, frame: StompFrame):
        version = frame.get_header("version") or "unknown"
        logger.info(f"[POPO-WS] STOMP CONNECTED (version={version})")
        self._state = ClientState.CONNECTED
        self._retry_count = 0

        # 发送 SUBSCRIBE
        self._subscription_id = f"sub-{uuid.uuid4().hex[:8]}"
        destination = f"{self._destination_prefix}/{self._robot_uid}"
        subscribe_frame = build_subscribe_frame(destination, self._subscription_id)
        ws.send(subscribe_frame.serialize())
        logger.info(f"[POPO-WS] Subscribed to {destination}")

        # 启动心跳
        self._start_heartbeat(ws)

    def _handle_message(self, frame: StompFrame):
        body = frame.body
        if body:
            # 在子线程中处理消息
            t = threading.Thread(
                target=self._message_handler.handle_message,
                args=(body,),
                daemon=True,
                name="popo-ws-msg",
            )
            t.start()

    def _handle_error(self, ws, frame: StompFrame):
        msg = frame.get_header("message") or ""
        logger.error(f"[POPO-WS] STOMP ERROR: {msg} body={frame.body}")
        self._stop_heartbeat()
        try:
            ws.close()
        except Exception:
            pass

    # ========== 心跳 ==========

    def _start_heartbeat(self, ws):
        self._stop_heartbeat()
        if self._heartbeat_interval_ms <= 0:
            return

        def send_heartbeat():
            if self._state == ClientState.CONNECTED and ws:
                try:
                    ws.send(build_heartbeat_frame().serialize())
                    ws.send("\n")
                except Exception:
                    logger.warning("[POPO-WS] Heartbeat send failed")

                # 重新调度
                if not self._stop_event.is_set() and self._state == ClientState.CONNECTED:
                    self._heartbeat_timer = threading.Timer(
                        self._heartbeat_interval_ms / 1000.0, send_heartbeat
                    )
                    self._heartbeat_timer.daemon = True
                    self._heartbeat_timer.start()

        self._heartbeat_timer = threading.Timer(
            self._heartbeat_interval_ms / 1000.0, send_heartbeat
        )
        self._heartbeat_timer.daemon = True
        self._heartbeat_timer.start()
        logger.debug(f"[POPO-WS] Heartbeat started (interval={self._heartbeat_interval_ms}ms)")

    def _stop_heartbeat(self):
        if self._heartbeat_timer:
            self._heartbeat_timer.cancel()
            self._heartbeat_timer = None
