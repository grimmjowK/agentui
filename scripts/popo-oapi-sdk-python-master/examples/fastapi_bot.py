#!/usr/bin/env python3
"""
POPO 机器人 — FastAPI 集成示例

演示如何在 FastAPI 应用中后台运行 POPO 长链接，利用 lifespan 管理生命周期。

安装依赖：
    pip install popo-oapi-sdk fastapi uvicorn python-dotenv

配置方式（二选一）：
    方式1 - .env 文件（推荐）：在当前目录创建 .env 文件
        POPO_APP_KEY=your-app-key
        POPO_APP_SECRET=your-app-secret
        POPO_AES_KEY=your-32-char-aes-key

    方式2 - 环境变量：
        export POPO_APP_KEY="your-app-key"
        export POPO_APP_SECRET="your-app-secret"
        export POPO_AES_KEY="your-32-char-aes-key"

启动：
    uvicorn fastapi_bot:app --host 0.0.0.0 --port 8000
"""

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from popo_sdk import PopoWsClient, EventDispatcher

# 加载 .env 文件（如果存在）
load_dotenv(Path(__file__).parent / ".env")

# 日志配置
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ========== Step 1: 初始化 SDK ==========

dispatcher = EventDispatcher()


@dispatcher.on_p2p_message
def on_p2p_message(event):
    data = event.event_data
    logger.info("📩 私聊消息 | from=%s | content=%s", data.from_, data.notify)
    # 在这里写业务逻辑，例如调用 AI 接口回复...


@dispatcher.on_group_at_message
def on_group_at_message(event):
    data = event.event_data
    logger.info("📢 群@消息 | from=%s | group=%s | content=%s", data.from_, data.session_id, data.notify)


@dispatcher.on_p2p_recall
def on_p2p_recall(event):
    data = event.event_data
    logger.info("🔙 私聊撤回 | from=%s | msgId=%s", data.from_, data.uuid)


@dispatcher.on_message_edit
def on_message_edit(event):
    data = event.event_data
    logger.info("✏️ 消息编辑 | from=%s | newContent=%s", data.from_, data.notify)


client = PopoWsClient(
    app_key=os.environ.get("POPO_APP_KEY", "your-app-key"),
    app_secret=os.environ.get("POPO_APP_SECRET", "your-app-secret"),
    aes_key=os.environ.get("POPO_AES_KEY"),  # 可选，未开启加密时为 None
    event_dispatcher=dispatcher,
)

# ========== Step 2: FastAPI lifespan 管理 ==========


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时开启长链接，关闭时断开"""
    client.start_background()
    logger.info("🤖 POPO 长链接已在后台启动")
    yield
    client.close()
    logger.info("🤖 POPO 长链接已关闭")


# ========== Step 3: FastAPI 应用 ==========

app = FastAPI(
    title="POPO Bot",
    description="POPO 机器人 FastAPI 示例",
    lifespan=lifespan,
)


@app.get("/health")
def health():
    """健康检查接口"""
    return {
        "status": "ok",
        "popo_ws_state": client.state.value,
    }


@app.get("/")
def root():
    return {"message": "POPO Bot is running! Check /health for status."}
