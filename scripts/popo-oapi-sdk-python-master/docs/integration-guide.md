# POPO 开放平台 Python SDK 接入手册

> 版本：1.0.0 | 适用范围：POPO 开放平台机器人开发者（Python）

---

## 目录

1. [前置准备](#1-前置准备)
2. [安装 SDK](#2-安装-sdk)
3. [快速接入（5 分钟）](#3-快速接入5-分钟)
4. [连接配置详解](#4-连接配置详解)
5. [事件处理](#5-事件处理)
6. [消息数据结构](#6-消息数据结构)
7. [AES 消息解密](#7-aes-消息解密)
8. [生命周期管理](#8-生命周期管理)
9. [Web 框架集成](#9-web-框架集成)
10. [日志与调试](#10-日志与调试)
11. [常见问题](#11-常见问题)
12. [工作原理](#12-工作原理)

---

## 1. 前置准备

### 1.1 注册机器人应用

1. 登录 [POPO 开放平台](https://open.popo.netease.com)
2. 创建机器人应用，获取以下凭证：
   - **appKey**：应用唯一标识
   - **appSecret**：应用密钥（妥善保管，不要提交到代码库）
   - **aesKey**（可选）：若开启消息加密，需配置此密钥（32 字符）

### 1.2 环境要求

| 要求 | 版本 |
|------|------|
| Python | 3.8 及以上 |
| pip | 20.0 及以上 |
| 网络 | 能访问 `nws.popo.netease.com:11012`（WebSocket）和 `open.popo.netease.com`（API） |

### 1.3 依赖说明

SDK 会自动安装以下依赖：

| 依赖包 | 版本 | 用途 |
|--------|------|------|
| `websocket-client` | ≥1.6.0 | WebSocket 长链接 |
| `requests` | ≥2.28.0 | Token 认证 HTTP 请求 |
| `pycryptodome` | ≥3.18.0 | AES-128-CBC 消息解密 |

---

## 2. 安装 SDK

### 2.1 pip 安装（推荐）

```bash
pip install popo-oapi-sdk
```

### 2.2 本地开发安装

如果你拿到的是 SDK 源码，使用可编辑模式安装：

```bash
cd /path/to/popo-oapi-sdk-python
pip install -e .
```

### 2.3 验证安装

```python
>>> import popo_sdk
>>> popo_sdk.__version__
'1.0.0'
```

---

## 3. 快速接入（5 分钟）

最简单的接入方式，接收私聊消息并打印：

```python
from popo_sdk import PopoWsClient, EventDispatcher

# Step 1：创建事件分发器，注册事件处理器
dispatcher = EventDispatcher()

@dispatcher.on_p2p_message
def on_message(event):
    data = event.event_data
    print(f"收到来自 {data.from_} 的消息: {data.notify}")
    # 在这里添加你的业务逻辑...

# Step 2：创建客户端
client = PopoWsClient(
    app_key="your-app-key",        # 替换为你的 appKey
    app_secret="your-app-secret",  # 替换为你的 appSecret
    aes_key="your-32-char-aes-key!!!!!!!!",  # 替换为你的 aesKey（32字符）
    event_dispatcher=dispatcher,
)

# Step 3：启动长链接（阻塞运行，Ctrl+C 退出）
client.start()
```

将上述代码保存为 `bot.py`，运行：

```bash
python bot.py
```

看到以下日志表示启动成功：

```
INFO [popo_sdk.client] [POPO-WS] Starting POPO WebSocket client...
INFO [popo_sdk.auth]   [POPO-WS] AccessToken refreshed, expires at: 1713180000000
INFO [popo_sdk.auth]   [POPO-WS] OnceToken obtained, robotUid: 12345678
INFO [popo_sdk.client] [POPO-WS] Connecting to wss://nws.popo.netease.com:11012 (robotUid=12345678)
INFO [popo_sdk.client] [POPO-WS] WebSocket connected, sending STOMP CONNECT...
INFO [popo_sdk.client] [POPO-WS] STOMP CONNECTED (version=1.1)
INFO [popo_sdk.client] [POPO-WS] Subscribed to /robots/msg/OpenClaw/12345678
```

---

## 4. 连接配置详解

### 4.1 完整配置示例

```python
client = PopoWsClient(
    # ── 必填 ──────────────────────────────────────────────
    app_key="your-app-key",
    app_secret="your-app-secret",
    event_dispatcher=dispatcher,

    # ── 消息加密（开启加密时必须配置）─────────────────────
    aes_key="AbCdEfGhIjKlMnOp0123456789abcdef",  # 必须是 32 字符

    # ── 服务地址（一般不需要修改）──────────────────────────
    base_url="https://open.popo.netease.com",           # POPO API 地址
    mercury_url="wss://nws.popo.netease.com:11012",     # Mercury WS 地址

    # ── 连接行为调整 ────────────────────────────────────────
    heartbeat_interval_ms=10000,          # 心跳间隔，默认 10 秒
    message_expiration_ms=30 * 60 * 1000, # 消息有效期，默认 30 分钟
    destination_prefix="/robots/msg/OpenClaw",  # 订阅路径前缀（一般不改）
)
```

### 4.2 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:----:|--------|------|
| `app_key` | str | ✅ | — | POPO 开放平台颁发的应用 Key |
| `app_secret` | str | ✅ | — | POPO 开放平台颁发的应用 Secret |
| `event_dispatcher` | EventDispatcher | ✅ | — | 事件分发器实例 |
| `aes_key` | str | 条件必填 | `None` | AES 解密密钥（32字符），开启消息加密时必须配置 |
| `base_url` | str | ❌ | `https://open.popo.netease.com` | POPO API 服务域名 |
| `mercury_url` | str | ❌ | `wss://nws.popo.netease.com:11012` | Mercury WebSocket 服务地址 |
| `heartbeat_interval_ms` | int | ❌ | `10000` | 心跳发送间隔（毫秒），0 表示禁用心跳 |
| `message_expiration_ms` | int | ❌ | `1800000` | 消息过期时间（毫秒），0 表示不检查 |
| `destination_prefix` | str | ❌ | `/robots/msg/OpenClaw` | STOMP 订阅目标前缀 |

> ⚠️ **安全提示**：`app_secret` 和 `aes_key` 切勿硬编码在代码中，建议通过环境变量或配置文件注入：
>
> ```python
> import os
>
> client = PopoWsClient(
>     app_key=os.environ["POPO_APP_KEY"],
>     app_secret=os.environ["POPO_APP_SECRET"],
>     aes_key=os.environ.get("POPO_AES_KEY"),  # 可选
>     event_dispatcher=dispatcher,
> )
> ```

---

## 5. 事件处理

### 5.1 支持的事件类型

| 事件类型常量 | 触发场景 | 注册装饰器 |
|-------------|----------|---------|
| `IM_P2P_TO_ROBOT_MSG` | 用户给机器人发私聊消息 | `@dispatcher.on_p2p_message` |
| `IM_CHAT_TO_ROBOT_AT_MSG` | 在群里 @ 机器人 | `@dispatcher.on_group_at_message` |
| `IM_P2P_USER_RECALL_MSG` | 用户撤回私聊消息 | `@dispatcher.on_p2p_recall` |
| `IM_CHAT_USER_RECALL_AT_MSG` | 用户撤回群里 @ 机器人的消息 | `@dispatcher.on_group_recall` |
| `IM_MSG_EDIT` | 用户编辑了消息 | `@dispatcher.on_message_edit` |
| `AUTH_USER_INVOKED` | 用户触发授权调用 | `@dispatcher.on_auth_user_invoked` |

### 5.2 装饰器风格注册（推荐）

```python
from popo_sdk import EventDispatcher

dispatcher = EventDispatcher()

# 处理私聊消息
@dispatcher.on_p2p_message
def on_p2p_message(event):
    data = event.event_data
    print(f"[私聊] {data.from_} → 机器人: {data.notify}")

# 处理群 @消息
@dispatcher.on_group_at_message
def on_group_at_message(event):
    data = event.event_data
    print(f"[群@] {data.from_} 在群 {data.session_id} 中@了机器人: {data.notify}")

# 处理消息撤回
@dispatcher.on_p2p_recall
def on_p2p_recall(event):
    print(f"[撤回] 消息 ID: {event.event_data.uuid}")

# 处理群消息撤回
@dispatcher.on_group_recall
def on_group_recall(event):
    print(f"[群撤回] 消息 ID: {event.event_data.uuid}")

# 处理消息编辑
@dispatcher.on_message_edit
def on_message_edit(event):
    data = event.event_data
    print(f"[编辑] {data.from_} 编辑了消息: {data.notify}")

# 处理用户授权调用
@dispatcher.on_auth_user_invoked
def on_auth_user_invoked(event):
    data = event.event_data
    print(f"[授权] 用户: {data.from_}, 外部参数: {data.extern_param}")
```

### 5.3 方法链风格注册

如果你更习惯 Java Builder 风格，也可以用方法链：

```python
from popo_sdk import EventDispatcher

dispatcher = (
    EventDispatcher()
    .on_p2p_message(lambda event: print(f"私聊: {event.event_data.notify}"))
    .on_group_at_message(lambda event: print(f"群@: {event.event_data.notify}"))
    .on_p2p_recall(lambda event: print(f"撤回: {event.event_data.uuid}"))
)
```

### 5.4 通用事件注册

对于自定义事件类型，使用 `on_event()` 方法：

```python
from popo_sdk import EventDispatcher, EventType

dispatcher = EventDispatcher()

@dispatcher.on_event(EventType.AUTH_USER_INVOKED)
def on_auth(event):
    print(f"授权调用: {event.event_data.from_}")
```

### 5.5 Handler 中的异常处理

SDK 内部会捕获 Handler 中抛出的所有异常，不会因为单个 Handler 崩溃而影响其他消息的处理。但建议你在 Handler 内部自行 try/except，以便更精细地控制错误处理逻辑：

```python
@dispatcher.on_p2p_message
def on_message(event):
    try:
        # 你的业务逻辑
        process_message(event)
    except DatabaseError as e:
        # 数据库写入失败，记录告警
        alert_service.warn(f"消息存储失败: {e}")
    except Exception as e:
        logger.error(f"处理消息失败: {e}", exc_info=True)
```

> 💡 **最佳实践**：Handler 应尽量快速返回。如果业务处理耗时较长（如调用外部 API），建议将任务投递到线程池或异步队列中处理：
>
> ```python
> from concurrent.futures import ThreadPoolExecutor
>
> executor = ThreadPoolExecutor(max_workers=10)
>
> @dispatcher.on_p2p_message
> def on_message(event):
>     # 将耗时操作提交到线程池
>     executor.submit(call_ai_api, event.event_data.notify)
> ```

---

## 6. 消息数据结构

### 6.1 事件对象（PopoEvent）

```
PopoEvent
├── event_type: EventType          事件类型枚举
├── event_data: PopoEventData      消息主体数据
└── meta: PopoEventMeta            元信息（Token等）
```

### 6.2 消息数据（PopoEventData）字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `uuid` | str | 消息唯一 ID |
| `from_` | str | 发送者邮箱（如 `zhangsan@corp.com`），注意：`from` 是 Python 保留字，此处用 `from_` |
| `to` | str | 接收者（私聊为机器人邮箱，群聊为群 ID） |
| `notify` | str | 消息正文内容 |
| `msg_type` | int | 消息类型（见下表） |
| `addtime` | str | 消息发送时间 |
| `session_type` | int | 会话类型：`1`=私聊，`3`=群聊 |
| `session_id` | str | 会话 ID |
| `at_type` | int | @ 类型（群聊消息） |
| `at_list` | list[str] | @ 的用户列表 |
| `robot_ids` | list[str] | 被 @ 的机器人 ID 列表 |
| `quote_info` | dict | 引用消息信息（msg_type=211 时有值） |
| `quote_infos` | list[dict] | 多引用消息（msg_type=213 时有值） |
| `file_info` | dict | 文件信息（msg_type=171 时有值） |
| `audio_info` | dict | 音频信息（msg_type=141 时有值） |
| `video_info` | dict | 视频信息（msg_type=142 时有值） |
| `merge_list` | list[dict] | 合并消息列表（msg_type=161 时有值） |
| `merge_title` | str | 合并消息标题 |
| `instruction_id` | str | 指令 ID（指令机器人） |
| `instruction_name` | str | 指令名称 |
| `instruct_variables` | list[dict] | 指令变量列表 |
| `recall_time` | str | 撤回时间（撤回事件时有值） |
| `edit_time` | str | 编辑时间（编辑事件时有值） |
| `extern_param` | str | 外部参数（授权调用事件） |

### 6.3 元信息（PopoEventMeta）

| 字段 | 类型 | 说明 |
|------|------|------|
| `auth` | dict | 认证信息 |
| `properties` | dict | 扩展属性 |
| `fabric_agent_token` | str (属性) | Fabric Agent Token（从 properties 中提取） |

### 6.4 消息类型（msg_type）枚举

| msg_type 值 | 消息类型 | `notify` 字段内容 |
|:----------:|----------|------------------|
| `1` | 普通文本 | 消息文字内容 |
| `141` | 语音消息 | 语音描述文字 |
| `142` | 视频消息 | 视频描述文字 |
| `161` | 合并消息 | 合并消息摘要 |
| `171` | 文件消息 | 文件名 |
| `211` | 引用消息 | 引用+回复的内容 |
| `213` | 多引用消息 | 引用+回复的内容 |

### 6.5 代码示例：按消息类型处理

```python
@dispatcher.on_p2p_message
def on_message(event):
    data = event.event_data

    if data.msg_type == 1:
        # 普通文本消息
        print(f"文本: {data.notify}")

    elif data.msg_type == 141:
        # 语音消息
        print(f"语音: {data.notify}")
        print(f"语音详情: {data.audio_info}")

    elif data.msg_type == 142:
        # 视频消息
        print(f"视频: {data.notify}")
        print(f"视频详情: {data.video_info}")

    elif data.msg_type == 161:
        # 合并消息
        count = len(data.merge_list) if data.merge_list else 0
        print(f"合并转发: {data.merge_title} ({count} 条)")

    elif data.msg_type == 171:
        # 文件消息
        print(f"文件名: {data.notify}")
        print(f"文件详情: {data.file_info}")
        # file_info 包含文件 URL、大小等信息

    elif data.msg_type == 211:
        # 引用消息
        print(f"引用回复: {data.notify}")
        print(f"被引用原文: {data.quote_info}")
        # quote_info 包含被引用的原消息内容

    elif data.msg_type == 213:
        # 多引用消息
        print(f"多引用消息: {data.notify}")
        print(f"引用列表: {data.quote_infos}")

    else:
        print(f"其他类型({data.msg_type}): {data.notify}")
```

### 6.6 获取 Fabric Agent Token

某些场景下需要使用 `fabricAgentToken` 与 POPO 平台进行后续交互：

```python
@dispatcher.on_p2p_message
def on_message(event):
    # 从 meta 中获取 fabricAgentToken
    token = event.meta.fabric_agent_token
    if token:
        print(f"Fabric Agent Token: {token}")
        # 用此 Token 调用 POPO 平台其他 API...
```

---

## 7. AES 消息解密

POPO 平台支持对消息内容进行 AES 加密传输。如果你的应用配置了消息加密，**必须**在 SDK 中配置 `aes_key`，否则将无法解析消息内容。

### 7.1 aesKey 格式

- 长度：**恰好 32 个字符**（UTF-8）
- 前 16 字符：AES-128 加密密钥
- 后 16 字符：IV（初始化向量）
- 算法：AES-128-CBC / PKCS7Padding

```python
# 示例（实际密钥从 POPO 开放平台获取）
aes_key = "AbCdEfGhIjKlMnOp0123456789abcdef"
#          |---- 前16位 key ----||--- 后16位 iv ---|
```

### 7.2 配置后的效果

配置 `aes_key` 后，SDK 会自动处理以下三种加密格式，开发者无需关心解密细节：

```
格式一：{"encrypt": "base64encoded..."}   ← 标准加密格式
格式二："base64encoded..."              ← 原始加密字符串
格式三：{"eventType": "...", ...}       ← 未加密（明文）
```

### 7.3 未配置 aesKey 但消息已加密

若平台开启了加密但 SDK 未配置 `aes_key`，SDK 会在日志中输出以下警告并丢弃该消息：

```
WARNING [popo_sdk.message] [POPO-WS] Message encrypted but no aes_key configured, skipping
```

### 7.4 手动使用加解密工具

如果需要在 SDK 之外单独使用解密功能（如 HTTP Webhook 场景）：

```python
from popo_sdk.crypto import decrypt, verify_signature

# 解密消息
plain_text = decrypt(encrypted_base64_string, aes_key)

# 验证签名（HTTP Webhook 场景）
is_valid = verify_signature(
    token="your-token",
    timestamp="1713100000",
    nonce="random-nonce",
    signature="sha256-signature-from-header"
)
```

---

## 8. 生命周期管理

### 8.1 启动流程

```
client.start()
    ↓
TokenManager 获取 AccessToken
    ↓
TokenManager 获取 OnceToken（一次性令牌）
    ↓
建立 WebSocket 连接
    ↓
发送 STOMP CONNECT 帧
    ↓
收到 STOMP CONNECTED → 发送 SUBSCRIBE
    ↓
开始心跳 ← 正常运行中 → 接收消息
```

### 8.2 两种启动模式

**模式一：阻塞模式**（适合独立脚本、cron 任务）

```python
# start() 会阻塞当前线程，直到调用 close() 或进程退出
client.start()
```

**模式二：后台模式**（适合 Web 框架集成）

```python
# start_background() 在 daemon 线程中运行，立即返回
client.start_background()

# 之后可以继续执行其他代码（如启动 Flask/Django/FastAPI）
app.run(port=5000)
```

### 8.3 断线重连

SDK 内置自动重连机制，无需手动干预：

- **触发时机**：WebSocket 意外断开、心跳超时、STOMP ERROR
- **重连策略**：指数退避 + 随机抖动

```
重试次数  等待时间（约）
  1 次    0.8s ～ 1.2s
  2 次    1.6s ～ 2.4s
  3 次    3.2s ～ 4.8s
  4 次    6.4s ～ 9.6s
  5 次   12.8s ～ 19.2s
  6 次   25.6s ～ 38.4s
  7+次   48s   ～ 60s（封顶）
```

- 每次重连会重新获取 `OnceToken`，确保认证有效
- 重连成功后，等待时间自动重置

### 8.4 优雅关闭

在应用退出时，应主动关闭 SDK 连接，确保资源释放：

```python
# 方式一：显式调用
client.close()

# 方式二：信号处理（推荐，适合长驻服务）
import signal
import sys

def signal_handler(sig, frame):
    print("正在关闭 POPO WebSocket 连接...")
    client.close()
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# 方式三：atexit 注册
import atexit
atexit.register(client.close)

# 方式四：上下文管理器风格（手动）
try:
    client.start()
finally:
    client.close()
```

### 8.5 查询连接状态

```python
from popo_sdk import ClientState

state = client.state  # ClientState 枚举
# IDLE → CONNECTING → CONNECTED → CLOSING → CLOSED

if state == ClientState.CONNECTED:
    print("连接正常")
```

---

## 9. Web 框架集成

### 9.1 Flask 集成

```python
import os
import logging
from flask import Flask, jsonify
from popo_sdk import PopoWsClient, EventDispatcher

logging.basicConfig(level=logging.INFO)

# ── 事件处理 ──
dispatcher = EventDispatcher()

@dispatcher.on_p2p_message
def on_message(event):
    data = event.event_data
    print(f"收到消息: {data.from_} → {data.notify}")
    # 在这里写业务逻辑，如调用 AI 接口回复

@dispatcher.on_group_at_message
def on_group_at(event):
    data = event.event_data
    print(f"群@消息: {data.from_} → {data.notify}")

# ── 创建客户端 ──
client = PopoWsClient(
    app_key=os.environ["POPO_APP_KEY"],
    app_secret=os.environ["POPO_APP_SECRET"],
    aes_key=os.environ.get("POPO_AES_KEY"),
    event_dispatcher=dispatcher,
)

# ── Flask 应用 ──
app = Flask(__name__)

@app.route("/health")
def health():
    return jsonify({
        "status": "ok",
        "popo_ws_state": client.state.value,
    })

@app.route("/")
def index():
    return "POPO Bot is running!"

if __name__ == "__main__":
    # 后台启动长链接
    client.start_background()
    print("🤖 POPO 长链接已在后台启动")

    # 启动 Flask
    app.run(host="0.0.0.0", port=5000, debug=False)
```

### 9.2 Django 集成

```python
# myapp/popo_bot.py
import os
from popo_sdk import PopoWsClient, EventDispatcher

dispatcher = EventDispatcher()

@dispatcher.on_p2p_message
def on_message(event):
    from myapp.services import handle_popo_message
    handle_popo_message(event)

client = PopoWsClient(
    app_key=os.environ["POPO_APP_KEY"],
    app_secret=os.environ["POPO_APP_SECRET"],
    aes_key=os.environ.get("POPO_AES_KEY"),
    event_dispatcher=dispatcher,
)
```

```python
# myapp/apps.py
from django.apps import AppConfig

class MyAppConfig(AppConfig):
    name = "myapp"

    def ready(self):
        from myapp.popo_bot import client
        client.start_background()
```

### 9.3 FastAPI 集成

```python
import os
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from popo_sdk import PopoWsClient, EventDispatcher

logging.basicConfig(level=logging.INFO)

dispatcher = EventDispatcher()

@dispatcher.on_p2p_message
def on_message(event):
    data = event.event_data
    print(f"收到消息: {data.from_} → {data.notify}")

client = PopoWsClient(
    app_key=os.environ["POPO_APP_KEY"],
    app_secret=os.environ["POPO_APP_SECRET"],
    aes_key=os.environ.get("POPO_AES_KEY"),
    event_dispatcher=dispatcher,
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时开启长链接
    client.start_background()
    print("🤖 POPO 长链接已在后台启动")
    yield
    # 关闭时断开连接
    client.close()
    print("🤖 POPO 长链接已关闭")

app = FastAPI(lifespan=lifespan)

@app.get("/health")
def health():
    return {"status": "ok", "popo_ws_state": client.state.value}

@app.get("/")
def root():
    return {"message": "POPO Bot is running!"}
```

启动：

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

---

## 10. 日志与调试

### 10.1 日志配置

SDK 使用 Python 标准 `logging` 模块，所有日志以 `[POPO-WS]` 为前缀。

**基本配置：**

```python
import logging

# 查看 SDK 详细日志（调试阶段）
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
```

**精细控制各模块日志级别：**

```python
import logging

# 全局 INFO
logging.basicConfig(level=logging.INFO)

# 仅查看连接日志
logging.getLogger("popo_sdk.client").setLevel(logging.INFO)

# Token 相关 DEBUG 调试
logging.getLogger("popo_sdk.auth").setLevel(logging.DEBUG)

# 消息处理管道 DEBUG 调试
logging.getLogger("popo_sdk.message").setLevel(logging.DEBUG)

# 事件分发 WARNING（只看错误）
logging.getLogger("popo_sdk.dispatcher").setLevel(logging.WARNING)
```

### 10.2 日志模块列表

| Logger 名称 | 输出内容 |
|-------------|---------|
| `popo_sdk.client` | WebSocket 连接、STOMP 帧、心跳、重连 |
| `popo_sdk.auth` | Token 获取、刷新、过期 |
| `popo_sdk.message` | 消息去重、过期、解密、分发 |
| `popo_sdk.dispatcher` | Handler 执行、异常捕获 |
| `popo_sdk.crypto` | AES 解密过程 |

### 10.3 常用日志含义

| 日志内容 | 含义 |
|---------|------|
| `Starting POPO WebSocket client...` | SDK 开始启动 |
| `AccessToken refreshed, expires at: ...` | AccessToken 获取/刷新成功 |
| `OnceToken obtained, robotUid: ...` | OnceToken 获取成功 |
| `Connecting to wss://... (robotUid=...)` | 正在建立 WebSocket 连接 |
| `STOMP CONNECTED (version=1.1)` | 连接建立成功 |
| `Subscribed to /robots/msg/OpenClaw/xxx` | 消息订阅成功 |
| `WebSocket closed: code=1000` | 连接正常关闭 |
| `Reconnecting in 1200ms (attempt 1)` | 正在等待重连 |
| `Dropping duplicate message: xxx` | 去重机制丢弃了重复消息 |
| `Dropping expired message: xxx` | 消息超时被丢弃 |
| `No handler registered for event type: XXX` | 收到了未注册 Handler 的事件 |

---

## 11. 常见问题

### Q1：启动后没有收到任何消息，是什么原因？

**排查步骤：**

1. 确认日志中出现了 `STOMP CONNECTED` 和 `Subscribed to ...`，说明连接成功
2. 检查 POPO 开放平台上机器人是否已配置"消息订阅"
3. 尝试向机器人发一条私聊消息，确认 `@dispatcher.on_p2p_message` Handler 是否被触发
4. 如果消息被加密，检查是否正确配置了 `aes_key`

---

### Q2：报错 `AuthError: Failed to get AccessToken`

**可能原因：**
- `app_key` 或 `app_secret` 填写错误
- `base_url` 地址不正确
- 网络无法访问 `open.popo.netease.com`

**解决方式：** 用 curl 手动验证接口是否可达：

```bash
curl -X POST https://open.popo.netease.com/open-apis/robots/v1/token \
  -H "Content-Type: application/json" \
  -d '{"appKey":"your-app-key","appSecret":"your-app-secret"}'
```

---

### Q3：报错 `CryptoError: AES decryption failed` 或 `ValueError: aes_key must be 32 characters`

**可能原因：**
- `aes_key` 长度不是 32 字符
- `aes_key` 与 POPO 平台配置的不一致
- 消息实际上未加密，但 SDK 尝试解密了

**解决方式：**
```python
# 检查 aes_key 长度
assert len(aes_key) == 32, f"aes_key 长度应为 32，当前为 {len(aes_key)}"
```
- 登录 POPO 开放平台确认加密配置和密钥是否匹配

---

### Q4：连接一直重连，无法稳定

**可能原因：**
- 网络环境不稳定（建议在服务器上部署）
- OnceToken 快速失效（每次重连都会重新获取，通常无问题）
- Mercury 服务限制了同一应用的连接数

**解决方式：** 打开 DEBUG 日志，查看 STOMP ERROR 帧的 `message` 字段：

```python
logging.getLogger("popo_sdk.client").setLevel(logging.DEBUG)
```

---

### Q5：import 报错 `ModuleNotFoundError: No module named 'popo_sdk'`

**可能原因：**
- SDK 未安装
- Python 环境不对（如系统自带 Python 而非 venv）

**解决方式：**

```bash
# 确认安装
pip show popo-oapi-sdk

# 确认 Python 版本
python --version  # 需要 >= 3.8

# 如果使用虚拟环境
source venv/bin/activate
pip install popo-oapi-sdk
```

---

### Q6：`from_` 字段怎么是带下划线的？

因为 `from` 是 Python 关键字，不能用作属性名。SDK 中所有用到 `from` 的地方都改为 `from_`：

```python
# ✅ 正确
sender = event.event_data.from_

# ❌ 错误（语法报错）
sender = event.event_data.from
```

---

### Q7：在 Docker 中部署需要注意什么？

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 通过环境变量注入凭证
ENV POPO_APP_KEY=""
ENV POPO_APP_SECRET=""
ENV POPO_AES_KEY=""

CMD ["python", "bot.py"]
```

```yaml
# docker-compose.yml
services:
  popo-bot:
    build: .
    environment:
      POPO_APP_KEY: ${POPO_APP_KEY}
      POPO_APP_SECRET: ${POPO_APP_SECRET}
      POPO_AES_KEY: ${POPO_AES_KEY}
    restart: unless-stopped
```

---

## 12. 工作原理

### 12.1 完整连接时序

```
你的程序             SDK                   POPO 开放平台
   │                  │                          │
   │   client.start() │                          │
   │─────────────────>│                          │
   │                  │  POST /v1/token          │
   │                  │─────────────────────────>│
   │                  │  {accessToken, expiredAt}│
   │                  │<─────────────────────────│
   │                  │  POST /v1/im/onceToken   │
   │                  │─────────────────────────>│
   │                  │  {onceToken, robotUid}   │
   │                  │<─────────────────────────│
   │                  │                          │
   │                  │  WebSocket Upgrade       │ Mercury 服务
   │                  │─────────────────────────>│
   │                  │  101 Switching Protocols │
   │                  │<─────────────────────────│
   │                  │  STOMP CONNECT           │
   │                  │─────────────────────────>│
   │                  │  STOMP CONNECTED         │
   │                  │<─────────────────────────│
   │                  │  STOMP SUBSCRIBE         │
   │                  │─────────────────────────>│
   │                  │                          │
   │                  │═══════════ 就绪 ══════════│
   │                  │                          │
   │                  │   每 10s SEND /heart-beat│
   │                  │─────────────────────────>│
   │                  │                          │
   │  on_p2p_message()│  STOMP MESSAGE           │
   │<─────────────────│<─────────────────────────│ 用户发来消息
```

### 12.2 消息处理管道

```
STOMP MESSAGE 帧
       ↓
 JSON 解析为 MercuryMessage
 {messageId, messageType, timestamp, data}
       ↓
 过滤 MANAGEMENT 消息（直接跳过）
       ↓
 去重检查（LRU 缓存 200 条）
  └─ 重复 → 丢弃
       ↓
 过期检查（默认 30 分钟）
  └─ 过期 → 丢弃
       ↓
 data 字段解析 + AES 解密
  ├─ {"encrypt": "base64..."} → 解密
  ├─ "base64..."             → 解密
  └─ {"eventType": ...}      → 直接使用
       ↓
 构建 PopoEvent {event_type, event_data, meta}
       ↓
 EventDispatcher.dispatch()
       ↓
 你的 Handler(event)
```

### 12.3 SDK 架构图

```
┌──────────────────────────────────────────────────────┐
│                     你的业务代码                       │
│  @dispatcher.on_p2p_message / on_group_at_message    │
└───────────────────────┬──────────────────────────────┘
                        │ dispatch(event)
┌───────────────────────▼──────────────────────────────┐
│              EventDispatcher                          │
│  按 event_type 路由到对应 Handler                      │
└───────────────────────┬──────────────────────────────┘
                        │ handle_message(body)
┌───────────────────────▼──────────────────────────────┐
│              MessageHandler                           │
│  JSON 解析 → 去重 → 过期检查 → AES 解密 → 构建事件    │
└───────────────────────┬──────────────────────────────┘
                        │ STOMP MESSAGE
┌───────────────────────▼──────────────────────────────┐
│              PopoWsClient                             │
│  WebSocket + STOMP 协议 + 心跳 + 自动重连             │
└───────────────────────┬──────────────────────────────┘
                        │ get_once_token()
┌───────────────────────▼──────────────────────────────┐
│              TokenManager                             │
│  appKey/Secret → AccessToken → OnceToken              │
│  自动缓存 + 过期刷新 + 线程安全                        │
└──────────────────────────────────────────────────────┘
```

### 12.4 线程模型

```
主线程
  │
  ├─ client.start()               ← 阻塞模式直接运行
  │  或
  ├─ client.start_background()    ← 后台模式启动 daemon 线程
  │     └─ popo-ws-main (Thread)  ← WebSocket 连接循环
  │           │
  │           ├─ heartbeat (Timer) ← 定时发送心跳
  │           │
  │           └─ popo-ws-msg (Thread) ← 每条消息在独立线程处理
  │                 └─ Handler()
  │
  └─ 你的业务代码（Flask/Django/FastAPI 等）
```

SDK 内部使用 `threading` 模块（非 asyncio），确保与所有 Python Web 框架兼容。

---

*如有问题，请联系 POPO 开放平台技术支持。*
