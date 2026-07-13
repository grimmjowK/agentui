"""
POPO 开放平台 Python SDK

基于 STOMP over WebSocket 的长链接事件接收 SDK。

快速开始::

    from popo_sdk import PopoWsClient, EventDispatcher

    dispatcher = EventDispatcher()

    @dispatcher.on_p2p_message
    def handle(event):
        print(f"收到: {event.event_data.notify}")

    client = PopoWsClient(
        app_key="your-app-key",
        app_secret="your-app-secret",
        aes_key="your-32-char-aes-key",
        event_dispatcher=dispatcher,
    )
    client.start()
"""

from .client import PopoWsClient, ClientState
from .dispatcher import EventDispatcher
from .models import EventType, PopoEvent, PopoEventData, PopoEventMeta, I18nString
from .exceptions import PopoSdkError, AuthError, CryptoError, PopoConnectionError

__version__ = "1.0.0"

__all__ = [
    "PopoWsClient",
    "ClientState",
    "EventDispatcher",
    "EventType",
    "PopoEvent",
    "PopoEventData",
    "PopoEventMeta",
    "I18nString",
    "PopoSdkError",
    "AuthError",
    "CryptoError",
    "PopoConnectionError",
]
