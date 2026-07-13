#!/usr/bin/env python3
"""
POPO 机器人 — 独立脚本示例

演示所有事件类型的处理。直接 python simple_bot.py 运行。

安装依赖：
    pip install popo-oapi-sdk python-dotenv
    # 或本地开发：pip install -e /path/to/popo-oapi-sdk-python

配置方式（二选一）：
    方式1 - .env 文件（推荐）：在当前目录创建 .env 文件
        POPO_APP_KEY=your-app-key
        POPO_APP_SECRET=your-app-secret
        POPO_AES_KEY=your-32-char-aes-key

    方式2 - 环境变量：
        export POPO_APP_KEY="your-app-key"
        export POPO_APP_SECRET="your-app-secret"
        export POPO_AES_KEY="your-32-char-aes-key"
"""

import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from popo_sdk import PopoWsClient, EventDispatcher

# 加载 .env 文件（如果存在）
load_dotenv(Path(__file__).parent / ".env")

# 日志配置（调试阶段可改为 DEBUG 级别查看 SDK 内部细节）
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ========== Step 1: 创建事件分发器 ==========

dispatcher = EventDispatcher()


# ---- 私聊消息 ----
@dispatcher.on_p2p_message
def on_p2p_message(event):
    data = event.event_data
    logger.info("📩 私聊消息 | 发送者: %s | 消息类型: %s", data.from_, data.msg_type)

    if data.msg_type == 1:
        logger.info("   文本内容: %s", data.notify)
    elif data.msg_type == 141:
        logger.info("   语音消息: %s", data.audio_info)
    elif data.msg_type == 142:
        logger.info("   视频消息: %s", data.video_info)
    elif data.msg_type == 161:
        count = len(data.merge_list) if data.merge_list else 0
        logger.info("   合并转发: %s (%d 条)", data.merge_title, count)
    elif data.msg_type == 171:
        logger.info("   文件消息: %s | 详情: %s", data.notify, data.file_info)
    elif data.msg_type == 211:
        logger.info("   引用回复: %s | 引用: %s", data.notify, data.quote_info)
    elif data.msg_type == 213:
        logger.info("   多引用消息: %s", data.quote_infos)
    else:
        logger.info("   其他类型(%s): %s", data.msg_type, data.notify)


# ---- 群 @消息 ----
@dispatcher.on_group_at_message
def on_group_at_message(event):
    data = event.event_data
    logger.info("📢 群@消息 | 发送者: %s | 群: %s", data.from_, data.session_id)
    logger.info("   @列表: %s", data.at_list)

    if data.msg_type == 1:
        logger.info("   文本内容: %s", data.notify)
    elif data.msg_type == 171:
        logger.info("   文件消息: %s", data.notify)
    elif data.msg_type == 211:
        logger.info("   引用消息: %s", data.notify)
    else:
        logger.info("   消息类型(%s): %s", data.msg_type, data.notify)


# ---- 私聊撤回 ----
@dispatcher.on_p2p_recall
def on_p2p_recall(event):
    data = event.event_data
    logger.info("🔙 私聊撤回 | 发送者: %s | 消息ID: %s | 撤回时间: %s", data.from_, data.uuid, data.recall_time)


# ---- 群@撤回 ----
@dispatcher.on_group_recall
def on_group_recall(event):
    data = event.event_data
    logger.info("🔙 群@撤回 | 发送者: %s | 群: %s | 消息ID: %s", data.from_, data.session_id, data.uuid)


# ---- 消息编辑 ----
@dispatcher.on_message_edit
def on_message_edit(event):
    data = event.event_data
    logger.info("✏️ 消息编辑 | 发送者: %s | 消息ID: %s | 新内容: %s", data.from_, data.uuid, data.notify)


# ---- 用户授权调用 ----
@dispatcher.on_auth_user_invoked
def on_auth_user_invoked(event):
    data = event.event_data
    logger.info("🔑 用户授权 | 用户: %s | 外部参数: %s", data.from_, data.extern_param)


# ---- 用户入群 ----
@dispatcher.on_team_user_join
def on_team_user_join(event):
    data = event.event_data
    logger.info("👋 用户入群 | 群ID: %s | 用户: %s | 机器人: %s | 时间: %s",
                data.tid, data.uids, data.robot_id, data.timetag)
    # 在这里添加你的业务逻辑
    # 例如：给新成员发送欢迎消息、更新群成员缓存等
    if data.uids:
        for uid in data.uids:
            logger.info("   欢迎新成员: %s 加入群 %s", uid, data.tid)


# ---- 用户离群 ----
@dispatcher.on_team_user_leave
def on_team_user_leave(event):
    data = event.event_data
    logger.info("🚪 用户离群 | 群ID: %s | 用户: %s | 变动类型: %s",
                data.tid, data.uids, data.change_type)
    # 在这里添加你的业务逻辑
    # 例如：更新群成员缓存、清理离群用户数据等


# ---- 用户访问机器人会话 ----
@dispatcher.on_user_visit
def on_user_visit(event):
    data = event.event_data
    logger.info("👀 用户访问 | 用户: %s | 机器人: %s | 时间: %s",
                data.uid, data.robot_id, data.timetag)
    # 在这里添加你的业务逻辑
    # 例如：发送引导消息、记录访问日志、展示欢迎语等


# ---- 机器人指令推送 ----
@dispatcher.on_bot_command
def on_bot_command(event):
    data = event.event_data
    logger.info("⚡ 指令推送 | 用户: %s | 指令ID: %s | 指令名: %s | 会话: %s(%s)",
                data.uid, data.instruction_id, data.instruction_name,
                data.session_id, data.session_type)

    # 将 instruction_name (dict) 转为 I18nString 获取中文名
    # from popo_sdk import I18nString
    # name = I18nString.from_dict(data.instruction_name)
    # logger.info("   指令中文名: %s", name.zh)

    # 根据 instruction_id 路由到不同的处理方法
    if data.instruction_id == "help":
        logger.info("   用户触发了帮助指令")
    elif data.instruction_id == "status":
        logger.info("   用户触发了状态查询指令")
    else:
        logger.info("   未知指令: %s", data.instruction_id)


# ========== Step 2: 创建客户端并启动 ==========

if __name__ == "__main__":
    # 推荐通过环境变量注入凭证，避免硬编码
    app_key = os.environ.get("POPO_APP_KEY", "your-app-key")
    app_secret = os.environ.get("POPO_APP_SECRET", "your-app-secret")
    aes_key = os.environ.get("POPO_AES_KEY", "your-32-char-aes-key!!!!!!!!")

    client = PopoWsClient(
        app_key=app_key,
        app_secret=app_secret,
        aes_key=aes_key,            # aesKey 必须为 32 字符；未开启加密可设为 None
        event_dispatcher=dispatcher,
    )

    # 注册优雅关闭
    import signal
    import sys

    def signal_handler(sig, frame):
        logger.info("正在关闭...")
        client.close()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    logger.info("🤖 POPO 机器人已启动，等待消息... (Ctrl+C 退出)")
    client.start()
