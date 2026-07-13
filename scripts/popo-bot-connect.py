"""
POPO 机器人智能客服 - 消息路由服务

收到用户消息 → 调用 CloudCLI AI 接口 → 通过机器人回复用户

使用方式：
  1. 确保 CloudCLI UI server 在运行: IS_PLATFORM=true npm run server:dev
  2. 启动本脚本: source .venv/bin/activate && python scripts/popo-bot-connect.py
"""

import json
import os
import subprocess
import tempfile
import threading
import time
from collections import defaultdict
import requests
import popo_sdk
from popo_sdk import PopoWsClient, EventDispatcher

# ==================== 配置 ====================

# POPO 机器人凭证
APP_KEY = os.environ.get("POPO_APP_KEY", "FmsUxbLECVGG4JzWbYRS")
APP_SECRET = os.environ.get("POPO_APP_SECRET", "P9GnS3ZUVTrfRVCDfM5MO0WCmZCWW3IHpa28J3vJdnZ8DU5u1NGdgNEAmjABBArx")
AES_KEY = os.environ.get("POPO_AES_KEY", "HAT2EmPksEG630ssPXBrwNpXRN1tTb65")

# CloudCLI UI API 配置（IS_PLATFORM=true 模式无需 API Key）
CLOUDCLI_API_URL = os.environ.get("CLOUDCLI_API_URL", "http://localhost:3001/api/agent/")
PROJECT_PATH = os.environ.get("PROJECT_PATH", "/app")
SESSION_WORKDIR = os.environ.get("SESSION_WORKDIR", os.path.join(os.path.expanduser("~"), ".claude", "popo-sessions"))
AI_PROVIDER = os.environ.get("AI_PROVIDER", "codex")
AI_MODEL = os.environ.get("AI_MODEL", "deepseek-v4-pro")

# 机器人配置
ROBOT_NAME = "dreammaker 智能客服内测"

# 限制
MAX_REPLY_LENGTH = 4000
REQUEST_TIMEOUT = 120

# Session 过期时间（7 天）
SESSION_TTL = 7 * 24 * 3600

# ==================== Session 管理 ====================

# 格式: {session_key: {"session_id": str, "project_path": str, "last_active": float}}
_session_store = {}
_session_lock = threading.Lock()


def _get_session_key(sender_uid, context_id):
    """生成 session key: sender@context（context 为群 ID 或 P2P 的对方 UID）"""
    return f"{sender_uid}@{context_id}"


def _create_session_dir(session_key):
    """为新 session 创建独立工作目录"""
    safe_name = session_key.replace("@", "_at_").replace("/", "_")
    ts = time.strftime("%Y%m%d_%H%M%S")
    dir_name = f"{safe_name}_{ts}"
    session_dir = os.path.join(SESSION_WORKDIR, dir_name)
    os.makedirs(session_dir, exist_ok=True)
    # 写入一个 CLAUDE.md 让 AI 知道上下文
    agents_md = os.path.join(session_dir, "AGENTS.md")
    with open(agents_md, "w", encoding="utf-8") as f:
        f.write("# POPO 智能客服会话\n\n")
        f.write("你是一个智能客服助手，通过 POPO 机器人与用户对话。\n")
        f.write("请用中文回复，语言简洁友好。\n\n")
        f.write("dreammaker 线上服务运行故障排查，优先使用 dm-ts skill\n")
    return session_dir


def get_session_info(sender_uid, context_id):
    """获取已有 session 信息（未过期时复用）

    Returns:
        tuple: (session_id, project_path) 或 (None, None)
    """
    key = _get_session_key(sender_uid, context_id)
    with _session_lock:
        entry = _session_store.get(key)
        if entry and (time.time() - entry["last_active"]) < SESSION_TTL:
            entry["last_active"] = time.time()
            return entry["session_id"], entry["project_path"]
        # 过期或不存在，清除
        _session_store.pop(key, None)
        return None, None


def create_new_session(sender_uid, context_id):
    """创建新 session 的工作目录（session_id 待 API 返回后保存）

    Returns:
        str: 新建的 project_path
    """
    key = _get_session_key(sender_uid, context_id)
    project_path = _create_session_dir(key)
    with _session_lock:
        _session_store[key] = {
            "session_id": None,
            "project_path": project_path,
            "last_active": time.time(),
        }
    return project_path


def save_session_id(sender_uid, context_id, session_id):
    """保存 API 返回的 session_id"""
    if not session_id:
        return
    key = _get_session_key(sender_uid, context_id)
    with _session_lock:
        entry = _session_store.get(key)
        if entry:
            entry["session_id"] = session_id
            entry["last_active"] = time.time()

# ==================== 核心逻辑 ====================


def call_cloudcli_api(user_message, session_id=None, project_path=None):
    """调用 CloudCLI AI 接口获取回复（使用 SSE streaming 模式）

    Returns:
        tuple: (reply_text, new_session_id) 或 (None, None)
    """
    payload = {
        "projectPath": project_path or PROJECT_PATH,
        "message": user_message,
        "stream": True,
        "provider": AI_PROVIDER,
        "model": AI_MODEL,
    }
    if session_id:
        payload["sessionId"] = session_id

    try:
        resp = requests.post(CLOUDCLI_API_URL, json=payload, timeout=REQUEST_TIMEOUT, stream=True)
        if resp.status_code != 200:
            print(f"[API 错误] HTTP {resp.status_code}: {resp.text[:200]}")
            return None

        resp.encoding = "utf-8"

        # 解析 SSE 流，提取文本内容
        # 服务端 normalizeMessage 输出格式:
        #   kind='text', role='assistant', content=<string>  → AI 回复文本
        #   kind='stream_delta', content=<string>            → 流式增量文本
        #   kind='thinking'                                  → 思考过程(忽略)
        #   kind='tool_use'/'tool_result'                    → 工具调用(忽略)
        #   type='session-id', sessionId=<string>            → 会话 ID
        reply_parts = []
        new_session_id = None
        for line in resp.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data: "):
                continue
            data_str = line[6:]
            try:
                data = json.loads(data_str)
            except json.JSONDecodeError:
                continue

            # 提取 session ID
            if data.get("type") == "session-id" and data.get("sessionId"):
                new_session_id = data["sessionId"]
                continue

            kind = data.get("kind", "")
            # 完整文本块 (kind=text, role=assistant, content=string)
            if kind == "text" and data.get("role") == "assistant":
                content = data.get("content", "")
                if isinstance(content, str) and content:
                    reply_parts.append(content)
            # 流式增量文本 (kind=stream_delta, content=string)
            elif kind == "stream_delta":
                content = data.get("content", "")
                if isinstance(content, str) and content:
                    reply_parts.append(content)

        reply_text = "".join(reply_parts).strip()
        if reply_text:
            print(f"[AI 回复] {len(reply_text)} 字符: {reply_text[:200]}")
            return reply_text, new_session_id
        else:
            print(f"[API 调试] SSE 流中未找到文本回复")
            return None, new_session_id

    except requests.Timeout:
        print(f"[API 超时] 请求超过 {REQUEST_TIMEOUT}s")
        return None, None
    except requests.ConnectionError:
        print("[API 连接失败] 请确保 CloudCLI server 在运行")
        return None, None
    except Exception as e:
        print(f"[API 异常] {e}")
        return None, None


def send_reply(receiver, message):
    """通过 popo-cli 发送机器人回复（使用临时文件避免编码问题）"""
    if len(message) > MAX_REPLY_LENGTH:
        message = message[:MAX_REPLY_LENGTH] + "\n\n...(回复过长已截断)"

    tmp_file = None
    try:
        tmp_file = tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False, encoding="utf-8"
        )
        tmp_file.write(message)
        tmp_file.close()

        result = subprocess.run(
            [
                "popo-cli", "popo", "use_robot_send_msg",
                f"robotName={ROBOT_NAME}",
                f"receiver={receiver}",
                f"message=@text:{tmp_file.name}",
                "msgType=text",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8"},
        )

        if result.returncode == 0:
            resp_data = json.loads(result.stdout) if result.stdout else {}
            if resp_data.get("ok"):
                # 检查最内层 data 是否有失败信息
                inner = resp_data.get("data", {}).get("data", {}).get("data", {})
                inner_msg = inner.get("message", "") if isinstance(inner, dict) else ""
                if "不在机器人" in inner_msg or "使用范围" in inner_msg:
                    print(f"[发送失败] {inner_msg}")
                    return False
                print(f"[发送成功] → {receiver}")
                return True
            else:
                print(f"[发送失败] {result.stdout[:200]}")
                return False
        else:
            print(f"[popo-cli 错误] returncode={result.returncode}, stderr={result.stderr[:200]}")
            return False

    except subprocess.TimeoutExpired:
        print("[发送超时] popo-cli 执行超时")
        return False
    except Exception as e:
        print(f"[发送异常] {e}")
        return False
    finally:
        if tmp_file and os.path.exists(tmp_file.name):
            os.unlink(tmp_file.name)


def handle_user_message(sender_uid, context_id, reply_to, message_text):
    """处理用户消息的完整流程（在独立线程中执行）

    Args:
        sender_uid: 消息发送者 UID
        context_id: 会话上下文 ID（P2P 用 sender_uid，群聊用 group_id）
        reply_to: 回复目标（P2P 回复给 sender，群聊回复到群）
        message_text: 用户消息内容
    """
    print(f"\n{'='*50}")
    print(f"[收到消息] 来自: {sender_uid}, 上下文: {context_id}")
    print(f"[消息内容] {message_text[:100]}{'...' if len(message_text) > 100 else ''}")
    print(f"{'='*50}")

    # 获取已有 session（同一用户+同一上下文 7 天内复用）
    session_id, project_path = get_session_info(sender_uid, context_id)
    if session_id:
        print(f"[Session] 复用已有会话: {session_id[:16]}...")
    else:
        # 新建独立工作目录
        project_path = create_new_session(sender_uid, context_id)
        print(f"[Session] 新建会话，目录: {project_path}")

    # 调用 AI
    print("[处理中] 正在调用 AI...")
    reply, new_session_id = call_cloudcli_api(message_text, session_id, project_path)

    # 保存 session_id
    if new_session_id:
        save_session_id(sender_uid, context_id, new_session_id)
        print(f"[Session] 已保存: {new_session_id[:16]}...")

    if reply:
        send_reply(reply_to, reply)
    else:
        send_reply(reply_to, "抱歉，服务暂时不可用，请稍后再试。")


# ==================== 事件处理 ====================

dispatcher = EventDispatcher()


@dispatcher.on_p2p_message
def on_p2p_message(event):
    """处理 P2P 消息"""
    data = event.event_data
    sender = data.from_
    message_text = data.notify

    if not sender or not message_text:
        return

    # P2P: sender 既是上下文也是回复目标
    thread = threading.Thread(
        target=handle_user_message,
        args=(sender, sender, sender, message_text),
        daemon=True,
    )
    thread.start()


@dispatcher.on_group_at_message
def on_group_at_message(event):
    """处理群组 @机器人 的消息，回复到群聊"""
    data = event.event_data
    sender = data.from_
    group_id = data.to  # 群聊会话 ID
    message_text = data.notify

    if not group_id or not message_text:
        return

    print(f"[群聊消息] 群: {group_id}, 发送者: {sender}")

    # 群聊: context 用 group_id（同群同用户共享上下文），回复到群
    thread = threading.Thread(
        target=handle_user_message,
        args=(sender, group_id, group_id, message_text),
        daemon=True,
    )
    thread.start()


# ==================== 启动 ====================

def main():
    print("=" * 60)
    print("  POPO 智能客服机器人启动")
    print(f"  机器人: {ROBOT_NAME}")
    print(f"  AI Provider: {AI_PROVIDER} ({AI_MODEL})")
    print(f"  API: {CLOUDCLI_API_URL}")
    print(f"  会话目录: {SESSION_WORKDIR}")
    print("=" * 60)
    print()

    os.makedirs(SESSION_WORKDIR, exist_ok=True)

    client = PopoWsClient(
        app_key=APP_KEY,
        app_secret=APP_SECRET,
        aes_key=AES_KEY,
        event_dispatcher=dispatcher,
    )

    print("[启动] 正在连接 POPO 长连接...")
    client.start()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[退出] 用户手动停止")
