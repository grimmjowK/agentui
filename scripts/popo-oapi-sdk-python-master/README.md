# POPO Open API SDK for Python

基于 STOMP over WebSocket 的 POPO 开放平台 Python 长链接 SDK，让开发者通过几行代码即可接收 POPO 机器人事件。

## 安装

```bash
pip install popo-oapi-sdk

# 或本地安装
pip install -e /path/to/popo-oapi-sdk-python
```

## 快速开始

### 独立脚本模式

```python
from popo_sdk import PopoWsClient, EventDispatcher

dispatcher = EventDispatcher()

@dispatcher.on_p2p_message
def handle(event):
    data = event.event_data
    print(f"收到来自 {data.from_} 的消息: {data.notify}")

@dispatcher.on_group_at_message
def handle_group(event):
    data = event.event_data
    print(f"群@消息: {data.notify}")

client = PopoWsClient(
    app_key="your-app-key",
    app_secret="your-app-secret",
    aes_key="your-32-char-aes-key!!!!!!!!",
    event_dispatcher=dispatcher,
)

client.start()  # 阻塞运行，Ctrl+C 退出
```

### Web 框架集成模式（Flask / Django / FastAPI 等）

```python
from flask import Flask
from popo_sdk import PopoWsClient, EventDispatcher

dispatcher = EventDispatcher()

@dispatcher.on_p2p_message
def handle(event):
    print(f"收到: {event.event_data.notify}")

client = PopoWsClient(
    app_key="your-app-key",
    app_secret="your-app-secret",
    aes_key="your-32-char-aes-key!!!!!!!!",
    event_dispatcher=dispatcher,
)

app = Flask(__name__)

# 后台启动长链接（daemon 线程，不阻塞 Web 服务）
client.start_background()

@app.route("/health")
def health():
    return {"status": "ok", "ws_state": client.state.value}

app.run(port=5000)
```

## 配置项

### 必填参数

| 参数 | 说明 |
|------|------|
| `app_key` | POPO 开放平台应用 Key |
| `app_secret` | POPO 开放平台应用 Secret |
| `event_dispatcher` | 事件分发器 |

### 可选参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `aes_key` | `None` | AES-128-CBC 解密密钥（32 字符），消息加密时必须配置 |
| `mercury_url` | `wss://nws.popo.netease.com:11012` | Mercury WebSocket 服务地址 |
| `base_url` | `https://open.popo.netease.com` | POPO 开放平台 API 基础地址 |
| `heartbeat_interval_ms` | `10000` (10秒) | 心跳发送间隔（毫秒） |
| `message_expiration_ms` | `1800000` (30分钟) | 消息过期时间（毫秒） |
| `destination_prefix` | `/robots/msg/OpenClaw` | STOMP 消息订阅目标前缀 |

## 支持的事件类型

| 事件类型 | 说明 | 注册方式 |
|----------|------|----------|
| `IM_P2P_TO_ROBOT_MSG` | 私聊消息 | `@dispatcher.on_p2p_message` |
| `IM_CHAT_TO_ROBOT_AT_MSG` | 群 @消息 | `@dispatcher.on_group_at_message` |
| `IM_P2P_USER_RECALL_MSG` | 私聊撤回 | `@dispatcher.on_p2p_recall` |
| `IM_CHAT_USER_RECALL_AT_MSG` | 群 @消息撤回 | `@dispatcher.on_group_recall` |
| `IM_MSG_EDIT` | 消息编辑 | `@dispatcher.on_message_edit` |
| `AUTH_USER_INVOKED` | 用户授权调用 | `@dispatcher.on_auth_user_invoked` |

## 消息数据结构

```python
@dispatcher.on_p2p_message
def handle(event):
    event.event_type             # EventType 枚举
    event.event_data.msg_type    # 消息类型 (1=文本, 141=音频, 142=视频, 161=合并, 171=文件, 211=引用)
    event.event_data.from_       # 发送者邮箱（注意下划线，from 是 Python 保留字）
    event.event_data.to          # 接收者
    event.event_data.uuid        # 消息 ID
    event.event_data.notify      # 消息内容
    event.event_data.addtime     # 发送时间
    event.event_data.session_type  # 1=私聊, 3=群聊
    event.event_data.session_id  # 会话 ID
    event.meta                   # 元信息 (fabricAgentToken 等)
```

## 两种注册风格

```python
# 风格 A: 装饰器（推荐）
dispatcher = EventDispatcher()

@dispatcher.on_p2p_message
def handle(event):
    print(event.event_data.notify)

# 风格 B: 方法链（兼容 Java 风格）
dispatcher = (EventDispatcher()
    .on_p2p_message(lambda e: print(e.event_data.notify))
    .on_group_at_message(lambda e: print(e.event_data.notify)))
```

## 架构说明

```
PopoWsClient.start()
    │
    ├─ TokenManager: appKey/appSecret → AccessToken → OnceToken
    │
    ├─ WebSocket: wss://nws.popo.netease.com:11012/stomp
    │
    ├─ STOMP: CONNECT → CONNECTED → SUBSCRIBE → MESSAGE...
    │
    ├─ MessageHandler: 去重 → 过期检查 → AES 解密
    │
    └─ EventDispatcher: 按 eventType 路由到你的 Handler
```

- **自动重连**：断线后指数退避重连（1s → 2s → 4s → ... → 60s），无限重试
- **消息去重**：维护最近 200 条消息 ID 的 LRU 缓存
- **消息过期**：默认丢弃超过 30 分钟的消息
- **线程安全**：Token 获取和消息去重均使用 threading.Lock

## License

MIT
