"""消息处理管道"""

import json
import logging
import threading
import time
from collections import OrderedDict
from typing import Optional

from .crypto import decrypt
from .dispatcher import EventDispatcher
from .exceptions import CryptoError
from .models import (
    EventType,
    MercuryMessage,
    PopoEvent,
    PopoEventData,
    PopoEventMeta,
)

logger = logging.getLogger("popo_sdk.message")

_DEDUP_CACHE_SIZE = 200
_MSG_TYPE_ROBOT_EVENT = "ROBOT_EVENT"
_MSG_TYPE_MANAGEMENT = "MANAGEMENT"


class MessageHandler:
    """消息处理管道：去重 → 过期 → 解密 → 分发"""

    def __init__(
        self,
        event_dispatcher: EventDispatcher,
        aes_key: Optional[str] = None,
        message_expiration_ms: int = 30 * 60 * 1000,
    ):
        self._dispatcher = event_dispatcher
        self._aes_key = aes_key
        self._message_expiration_ms = message_expiration_ms
        self._processed: OrderedDict = OrderedDict()
        self._lock = threading.Lock()

    def handle_message(self, message_body: str):
        """处理 STOMP MESSAGE 帧的 body"""
        try:
            raw = json.loads(message_body)
            msg = MercuryMessage.from_dict(raw)

            # 跳过管理消息
            if msg.message_type == _MSG_TYPE_MANAGEMENT:
                logger.debug(f"[POPO-WS] Skipping MANAGEMENT message: {msg.message_id}")
                return

            # 仅处理 ROBOT_EVENT
            if msg.message_type != _MSG_TYPE_ROBOT_EVENT:
                logger.debug(f"[POPO-WS] Skipping unknown messageType: {msg.message_type}")
                return

            # 去重
            if msg.message_id:
                with self._lock:
                    if msg.message_id in self._processed:
                        logger.debug(f"[POPO-WS] Dropping duplicate message: {msg.message_id}")
                        return
                    self._processed[msg.message_id] = True
                    # LRU 淘汰
                    while len(self._processed) > _DEDUP_CACHE_SIZE:
                        self._processed.popitem(last=False)

            # 过期检查
            if msg.timestamp > 0 and self._message_expiration_ms > 0:
                now_ms = int(time.time() * 1000)
                age = now_ms - msg.timestamp
                if age > self._message_expiration_ms:
                    logger.info(f"[POPO-WS] Dropping expired message: {msg.message_id} (age={age}ms)")
                    return

            # 解析 data 字段
            event = self._extract_event(msg.data)
            if event is None:
                logger.warning(f"[POPO-WS] Failed to extract event from message: {msg.message_id}")
                return

            # 分发事件
            self._dispatcher.dispatch(event)

        except Exception:
            logger.exception("[POPO-WS] Error handling message")

    def _extract_event(self, data) -> Optional[PopoEvent]:
        """从 data 字段提取事件，处理三种格式"""
        if data is None:
            return None

        try:
            if isinstance(data, str):
                # 尝试 JSON 解析
                try:
                    parsed = json.loads(data)
                    if isinstance(parsed, dict):
                        return self._extract_from_dict(parsed)
                except (json.JSONDecodeError, ValueError):
                    pass

                # 可能是原始 base64 加密字符串
                if self._aes_key:
                    decrypted_json = decrypt(data, self._aes_key)
                    decrypted = json.loads(decrypted_json)
                    return self._build_event(decrypted)

            elif isinstance(data, dict):
                return self._extract_from_dict(data)

        except Exception:
            logger.exception("[POPO-WS] Failed to extract event from data")

        return None

    def _extract_from_dict(self, d: dict) -> Optional[PopoEvent]:
        # 格式 a: {"encrypt": "base64..."}
        if "encrypt" in d:
            if not self._aes_key:
                logger.error("[POPO-WS] Message encrypted but no aes_key configured!")
                return None
            decrypted_json = decrypt(d["encrypt"], self._aes_key)
            decrypted = json.loads(decrypted_json)
            return self._build_event(decrypted)

        # 格式 c: 未加密 JSON，直接包含 eventType
        if "eventType" in d:
            return self._build_event(d)

        return None

    @staticmethod
    def _build_event(d: dict) -> PopoEvent:
        event_type_str = d.get("eventType")
        event_type = EventType.from_string(event_type_str)

        event_data = None
        if "eventData" in d:
            event_data = PopoEventData.from_dict(d["eventData"])

        meta = None
        if "meta" in d:
            meta = PopoEventMeta.from_dict(d["meta"])

        return PopoEvent(event_type=event_type, event_data=event_data, meta=meta)
