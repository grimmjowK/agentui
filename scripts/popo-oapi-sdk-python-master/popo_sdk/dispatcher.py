"""事件分发器"""

import logging
from typing import Callable, Optional

from .models import EventType, PopoEvent

logger = logging.getLogger("popo_sdk.dispatcher")

# Handler 类型
EventHandler = Callable[[PopoEvent], None]


class EventDispatcher:
    """
    事件分发器 —— 按 eventType 路由事件到注册的 handler
    
    支持两种注册风格：
    
    1. 装饰器风格（推荐）：
        dispatcher = EventDispatcher()
        
        @dispatcher.on_p2p_message
        def handle(event):
            print(event.event_data.notify)
    
    2. 方法链风格：
        dispatcher = (EventDispatcher()
            .on_p2p_message(handler)
            .on_group_at_message(handler))
    """

    def __init__(self):
        self._handlers: dict = {}

    def _register(self, event_type: EventType, handler: Optional[EventHandler] = None):
        """注册 handler，支持装饰器和直接调用两种用法"""
        if handler is not None:
            # 直接调用: dispatcher.on_xxx(handler)
            self._handlers[event_type] = handler
            return self  # 返回 self 支持链式调用
        else:
            # 装饰器: @dispatcher.on_xxx
            def decorator(func: EventHandler):
                self._handlers[event_type] = func
                return func
            return decorator

    def on_p2p_message(self, handler: Optional[EventHandler] = None):
        """注册私聊消息 handler"""
        return self._register(EventType.IM_P2P_TO_ROBOT_MSG, handler)

    def on_group_at_message(self, handler: Optional[EventHandler] = None):
        """注册群 @消息 handler"""
        return self._register(EventType.IM_CHAT_TO_ROBOT_AT_MSG, handler)

    def on_p2p_recall(self, handler: Optional[EventHandler] = None):
        """注册私聊撤回 handler"""
        return self._register(EventType.IM_P2P_USER_RECALL_MSG, handler)

    def on_group_recall(self, handler: Optional[EventHandler] = None):
        """注册群 @消息撤回 handler"""
        return self._register(EventType.IM_CHAT_USER_RECALL_AT_MSG, handler)

    def on_message_edit(self, handler: Optional[EventHandler] = None):
        """注册消息编辑 handler"""
        return self._register(EventType.IM_MSG_EDIT, handler)

    def on_auth_user_invoked(self, handler: Optional[EventHandler] = None):
        """注册用户授权调用 handler"""
        return self._register(EventType.AUTH_USER_INVOKED, handler)

    def on_team_user_join(self, handler: Optional[EventHandler] = None):
        """注册用户入群 handler"""
        return self._register(EventType.TEAM_USER_JOIN_GROUP, handler)

    def on_team_user_leave(self, handler: Optional[EventHandler] = None):
        """注册用户离群 handler"""
        return self._register(EventType.TEAM_USER_LEAVE_GROUP, handler)

    def on_user_visit(self, handler: Optional[EventHandler] = None):
        """注册用户访问机器人会话 handler"""
        return self._register(EventType.IM_USER_VISIT, handler)

    def on_bot_command(self, handler: Optional[EventHandler] = None):
        """注册机器人指令推送 handler"""
        return self._register(EventType.IM_BOT_COMMAND_PUSH_EVENT, handler)

    def on_event(self, event_type: EventType, handler: EventHandler):
        """注册任意事件类型的 handler"""
        self._handlers[event_type] = handler
        return self

    def dispatch(self, event: PopoEvent):
        """按 eventType 分发事件到注册的 handler"""
        if not event or not event.event_type:
            logger.warning("[POPO-WS] Received null event or null event_type, ignoring")
            return

        handler = self._handlers.get(event.event_type)
        if handler is None:
            logger.warning(f"[POPO-WS] No handler registered for event_type: {event.event_type}")
            return

        try:
            handler(event)
        except Exception:
            logger.exception(f"[POPO-WS] Handler threw exception for event_type: {event.event_type}")
