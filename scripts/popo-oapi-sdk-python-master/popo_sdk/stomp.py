"""STOMP 协议帧解析与构建"""

from enum import Enum
from dataclasses import dataclass, field
from typing import List, Dict, Optional
import uuid


class StompCommand(Enum):
    """STOMP 协议命令"""
    CONNECT = "CONNECT"
    CONNECTED = "CONNECTED"
    SUBSCRIBE = "SUBSCRIBE"
    SEND = "SEND"
    MESSAGE = "MESSAGE"
    ERROR = "ERROR"
    DISCONNECT = "DISCONNECT"

    @classmethod
    def from_string(cls, value: str) -> Optional["StompCommand"]:
        if not value:
            return None
        try:
            return cls(value.upper().strip())
        except ValueError:
            return None


@dataclass
class StompFrame:
    """STOMP 协议帧"""
    command: StompCommand
    headers: Dict[str, str] = field(default_factory=dict)
    body: str = ""

    def get_header(self, key: str) -> Optional[str]:
        return self.headers.get(key)

    def serialize(self) -> str:
        """序列化为 STOMP 帧文本"""
        sb = []
        sb.append(self.command.value)
        sb.append("\n")
        for key, value in self.headers.items():
            sb.append(f"{key}:{value}")
            sb.append("\n")
        sb.append("\n")  # 空行分隔 headers 和 body
        if self.body:
            sb.append(self.body)
        sb.append("\0")
        return "".join(sb)

    @classmethod
    def parse(cls, data: str) -> List["StompFrame"]:
        """从原始数据解析多个 STOMP 帧（按 \\0 分割）"""
        frames = []
        if not data:
            return frames

        parts = data.split("\0")
        for part in parts:
            trimmed = part.strip()
            if not trimmed:
                continue

            lines = part.split("\n")
            # 第一个非空行是命令
            cmd_str = ""
            line_idx = 0
            for i, line in enumerate(lines):
                if line.strip():
                    cmd_str = line.strip()
                    line_idx = i + 1
                    break

            if not cmd_str:
                continue

            cmd = StompCommand.from_string(cmd_str)
            if cmd is None:
                continue

            # 解析 headers（直到空行）
            headers = {}
            while line_idx < len(lines):
                line = lines[line_idx]
                if not line:  # 空行 = headers 结束
                    line_idx += 1
                    break
                colon_idx = line.find(":")
                if colon_idx > 0:
                    key = line[:colon_idx].strip()
                    value = line[colon_idx + 1:].strip()
                    headers[key] = value
                line_idx += 1

            # 剩余部分是 body
            body = "\n".join(lines[line_idx:])

            frames.append(StompFrame(command=cmd, headers=headers, body=body))

        return frames


def build_connect_frame(heartbeat_interval_ms: int = 10000) -> StompFrame:
    """构建 STOMP CONNECT 帧"""
    return StompFrame(
        command=StompCommand.CONNECT,
        headers={
            "accept-version": "1.0,1.1,1.2",
            "host": "mercury",
            "heart-beat": f"{heartbeat_interval_ms},{heartbeat_interval_ms}",
        },
    )


def build_subscribe_frame(destination: str, subscription_id: str = None) -> StompFrame:
    """构建 STOMP SUBSCRIBE 帧"""
    if subscription_id is None:
        subscription_id = f"sub-{uuid.uuid4().hex[:8]}"
    return StompFrame(
        command=StompCommand.SUBSCRIBE,
        headers={
            "id": subscription_id,
            "destination": destination,
            "ack": "auto",
        },
    )


def build_heartbeat_frame() -> StompFrame:
    """构建心跳 SEND 帧"""
    return StompFrame(
        command=StompCommand.SEND,
        headers={"destination": "/heart-beat"},
    )


def build_disconnect_frame() -> StompFrame:
    """构建 STOMP DISCONNECT 帧"""
    return StompFrame(command=StompCommand.DISCONNECT)
