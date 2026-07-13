"""数据模型定义"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class EventType(Enum):
    """POPO 事件类型"""
    IM_P2P_TO_ROBOT_MSG = "IM_P2P_TO_ROBOT_MSG"
    IM_CHAT_TO_ROBOT_AT_MSG = "IM_CHAT_TO_ROBOT_AT_MSG"
    IM_P2P_USER_RECALL_MSG = "IM_P2P_USER_RECALL_MSG"
    IM_CHAT_USER_RECALL_AT_MSG = "IM_CHAT_USER_RECALL_AT_MSG"
    IM_MSG_EDIT = "IM_MSG_EDIT"
    AUTH_USER_INVOKED = "AUTH_USER_INVOKED"
    TEAM_USER_JOIN_GROUP = "TEAM_USER_JOIN_GROUP"
    TEAM_USER_LEAVE_GROUP = "TEAM_USER_LEAVE_GROUP"
    IM_USER_VISIT = "IM_USER_VISIT"
    IM_BOT_COMMAND_PUSH_EVENT = "IM_BOT_COMMAND_PUSH_EVENT"

    @classmethod
    def from_string(cls, value: str) -> Optional["EventType"]:
        if not value:
            return None
        try:
            return cls(value.upper().strip())
        except ValueError:
            return None


@dataclass
class PopoEventData:
    """POPO 事件数据"""
    msg_type: Optional[int] = None
    uuid: Optional[str] = None
    from_: Optional[str] = None       # 'from' 是 Python 保留字
    to: Optional[str] = None
    notify: Optional[str] = None
    addtime: Optional[str] = None
    session_type: Optional[int] = None
    session_id: Optional[str] = None
    at_type: Optional[int] = None
    at_list: Optional[List[str]] = None
    robot_ids: Optional[List[str]] = None
    quote_info: Optional[Dict] = None
    quote_infos: Optional[Dict] = None
    file_info: Optional[Dict] = None
    audio_info: Optional[Dict] = None
    video_info: Optional[Dict] = None
    merge_list: Optional[List[Dict]] = None
    merge_title: Optional[str] = None
    instruction_id: Optional[str] = None
    instruction_name: Optional[Dict] = None
    instruct_variables: Optional[List[Dict]] = None
    recall_time: Optional[str] = None
    edit_time: Optional[str] = None
    extern_param: Optional[str] = None
    # 增强消息内容（如将 [图片] 替换为实际图片链接）
    enhance_notify: Optional[str] = None
    # ===== 群成员变动事件 (TEAM_USER_JOIN_GROUP / TEAM_USER_LEAVE_GROUP) =====
    tid: Optional[str] = None                  # 群组 ID
    uids: Optional[List[str]] = None           # 变动的用户 UID 列表
    change_type: Optional[int] = None          # 变更类型：1=加入，2=离开（JSON 字段名 "type"）
    timetag: Optional[int] = None              # 事件时间戳
    robot_id: Optional[str] = None             # 机器人 ID
    # ===== 用户访问 / 指令推送事件 =====
    uid: Optional[str] = None                  # 用户 UID（访问者 / 指令触发者）

    @classmethod
    def from_dict(cls, data: dict) -> "PopoEventData":
        """从 camelCase JSON dict 构建实例"""
        if not data:
            return cls()
        return cls(
            msg_type=data.get("msgType"),
            uuid=data.get("uuid"),
            from_=data.get("from"),
            to=data.get("to"),
            notify=data.get("notify"),
            addtime=data.get("addtime"),
            session_type=data.get("sessionType"),
            session_id=data.get("sessionId"),
            at_type=data.get("atType"),
            at_list=data.get("atList"),
            robot_ids=data.get("robotIds"),
            quote_info=data.get("quoteInfo"),
            quote_infos=data.get("quoteInfos"),
            file_info=data.get("fileInfo"),
            audio_info=data.get("audioInfo"),
            video_info=data.get("videoInfo"),
            merge_list=data.get("mergeList"),
            merge_title=data.get("mergeTitle"),
            instruction_id=data.get("instructionId"),
            instruction_name=data.get("instructionName"),
            instruct_variables=data.get("instructVariables"),
            recall_time=data.get("recallTime"),
            edit_time=data.get("editTime"),
            extern_param=data.get("externParam"),
            enhance_notify=data.get("enhanceNotify"),
            tid=data.get("tid"),
            uids=data.get("uids"),
            change_type=data.get("type"),
            timetag=data.get("timetag"),
            robot_id=data.get("robotId"),
            uid=data.get("uid"),
        )


@dataclass
class PopoEventMeta:
    """POPO 事件元信息"""
    auth: Optional[Dict] = None
    properties: Optional[Dict] = None

    @property
    def fabric_agent_token(self) -> Optional[str]:
        if self.auth and "fabricAgentToken" in self.auth:
            return self.auth["fabricAgentToken"]
        return None

    @classmethod
    def from_dict(cls, data: dict) -> "PopoEventMeta":
        if not data:
            return cls()
        return cls(
            auth=data.get("auth"),
            properties=data.get("properties"),
        )


@dataclass
class PopoEvent:
    """POPO 事件"""
    event_type: Optional[EventType] = None
    event_data: Optional[PopoEventData] = None
    meta: Optional[PopoEventMeta] = None


@dataclass
class I18nString:
    """
    国际化字符串模型

    用于表示支持多语言的文本内容，如机器人指令名称（instructionName）。

    用法::

        # 将 instruction_name (dict) 转为 I18nString
        name = I18nString.from_dict(event.event_data.instruction_name)
        print(f"中文名: {name.zh}")
    """
    zh: Optional[str] = None   # 中文
    en: Optional[str] = None   # 英文
    ja: Optional[str] = None   # 日文

    @classmethod
    def from_dict(cls, data: dict) -> "I18nString":
        if not data:
            return cls()
        return cls(
            zh=data.get("zh"),
            en=data.get("en"),
            ja=data.get("ja"),
        )

    def __str__(self):
        return f"I18nString(zh='{self.zh}', en='{self.en}', ja='{self.ja}')"


@dataclass
class MercuryMessage:
    """Mercury WebSocket 传输的消息体"""
    message_id: Optional[str] = None
    message_type: Optional[str] = None
    timestamp: int = 0
    data: Any = None

    @classmethod
    def from_dict(cls, data: dict) -> "MercuryMessage":
        if not data:
            return cls()
        return cls(
            message_id=data.get("messageId"),
            message_type=data.get("messageType"),
            timestamp=data.get("timestamp", 0),
            data=data.get("data"),
        )
