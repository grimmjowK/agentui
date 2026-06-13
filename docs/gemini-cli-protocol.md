# Gemini CLI 通信协议文档

## 概述

CloudCLI UI 通过 **子进程 (PTY)** 方式与 Gemini CLI 通信，使用 **stdin/stdout JSON 流** 作为数据交换协议。前端通过 WebSocket 与后端通信，后端负责进程管理和消息标准化。

## 架构图

```
┌──────────────┐   WebSocket   ┌──────────────┐   stdin/stdout   ┌──────────────┐
│  前端 (React) │ ◄──────────► │ 后端 (Express) │ ◄──────────────► │  Gemini CLI   │
│              │              │              │    JSON Stream    │  (子进程/PTY)  │
└──────────────┘              └──────────────┘                   └──────────────┘
```

## 关键文件

| 文件 | 职责 |
|------|------|
| `server/gemini-cli.js` | 进程生成、生命周期管理、PTY 通信 |
| `server/gemini-response-handler.js` | JSON 流解析、事件标准化 |
| `server/index.js` | WebSocket 路由和消息分发 |
| `server/routes/gemini.js` | HTTP REST 接口（会话删除等） |
| `server/sessionManager.js` | 内存 + 磁盘会话存储 |
| `server/modules/providers/list/gemini/gemini-sessions.provider.ts` | 事件标准化、历史加载 |
| `server/modules/providers/list/gemini/gemini-mcp.provider.ts` | MCP 服务器配置 |
| `server/modules/providers/list/gemini/gemini-auth.provider.ts` | 认证状态检查 |

---

## 1. 进程生成

### 生成方式

- **主要方式**：`node-pty`（伪终端），提供交互式 TTY 环境
- **降级方式**：`child_process.spawn()`，当 PTY 不可用时使用

### CLI 路径解析

```
优先级：process.env.GEMINI_PATH > 系统 PATH 中的 'gemini' 命令
```

### PTY 配置

```javascript
{
  cols: 250,
  rows: 50,
  term: 'xterm-256color',
  env: process.env  // 继承父进程环境变量
}
```

### CLI 启动参数

```bash
gemini \
  --model <model_name> \          # 默认 gemini-2.5-flash
  --output-format stream-json \   # 固定，JSON 流输出
  --approval-mode <mode> \        # auto_edit | plan | yolo
  --prompt "<user_command>" \     # 无头模式，用户输入
  [--resume <cliSessionId>] \     # 恢复会话（可选）
  [--mcp-config <path>] \         # MCP 配置文件路径（可选）
  [--allowed-tools tool1,tool2] \ # 允许的工具列表（可选）
  [--debug]                       # 调试模式（可选）
```

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--model` | string | 是 | 模型名称，默认 `gemini-2.5-flash` |
| `--output-format` | string | 是 | 固定为 `stream-json` |
| `--approval-mode` | enum | 是 | `auto_edit`：自动批准编辑；`plan`：先展示计划；`yolo`：跳过所有权限提示 |
| `--prompt` | string | 是 | 用户输入的命令/提示词 |
| `--resume` | string | 否 | Gemini CLI 原生会话 ID，用于恢复会话 |
| `--mcp-config` | string | 否 | MCP 配置文件路径（`~/.gemini.json`） |
| `--allowed-tools` | string | 否 | 逗号分隔的允许工具列表 |
| `--debug` | flag | 否 | 启用调试输出 |

---

## 2. 通信协议：JSON Stream

### 协议格式

- **方向**：Gemini CLI stdout → 后端
- **编码**：UTF-8
- **格式**：行分隔的 JSON（Line-Delimited JSON），每行一个 JSON 对象
- **预处理**：去除 ANSI 转义序列，规范化换行符为 `\n`

### 解析流程

```
stdout 原始数据
  ↓ 去除 ANSI 转义序列
  ↓ 按 \n 分割为行
  ↓ 每行尝试 JSON.parse()
  ├─ 成功 → handleEvent(event)
  └─ 失败 → onNonJsonLine(line)  // 可能是权限提示等交互内容
```

---

## 3. Gemini CLI 输出事件类型

### 3.1 `init` - 会话初始化

```json
{
  "type": "init",
  "session_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定为 `"init"` |
| `session_id` | string (UUID) | Gemini CLI 原生会话 ID |

### 3.2 `message` - 文本消息

```json
{
  "type": "message",
  "role": "assistant",
  "content": "这是回复内容...",
  "delta": true,
  "timestamp": "2026-05-15T10:00:00.000Z",
  "uuid": "msg_xxx"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定为 `"message"` |
| `role` | enum | `"assistant"` 或 `"user"` |
| `content` | string | 消息文本内容 |
| `delta` | boolean | 是否为增量内容（流式片段） |
| `timestamp` | string | ISO 8601 时间戳 |
| `uuid` | string | 消息唯一标识 |

### 3.3 `tool_use` - 工具调用

```json
{
  "type": "tool_use",
  "tool_id": "tool_xxx",
  "tool_name": "EditFile",
  "parameters": {
    "path": "/src/index.ts",
    "content": "..."
  },
  "timestamp": "2026-05-15T10:00:01.000Z",
  "uuid": "tu_xxx"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定为 `"tool_use"` |
| `tool_id` | string | 工具调用唯一 ID |
| `tool_name` | string | 工具名称（如 `EditFile`, `ReadFile`, `Shell` 等） |
| `parameters` | object | 工具调用参数 |

### 3.4 `tool_result` - 工具执行结果

```json
{
  "type": "tool_result",
  "tool_id": "tool_xxx",
  "output": "文件已更新",
  "status": "success",
  "timestamp": "2026-05-15T10:00:02.000Z",
  "uuid": "tr_xxx"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定为 `"tool_result"` |
| `tool_id` | string | 对应的 `tool_use` 的 ID |
| `output` | any | 工具执行输出 |
| `status` | enum | `"success"` 或 `"error"` |

### 3.5 `result` - 完成事件

```json
{
  "type": "result",
  "stats": {
    "total_tokens": 1234
  },
  "timestamp": "2026-05-15T10:00:05.000Z",
  "uuid": "res_xxx"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定为 `"result"` |
| `stats.total_tokens` | number | 总 token 使用量 |

### 3.6 `error` - 错误事件

```json
{
  "type": "error",
  "error": "ApiError",
  "message": "Rate limit exceeded",
  "tool_id": "tool_xxx"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定为 `"error"` |
| `error` | string | 错误类型名称 |
| `message` | string | 错误描述 |
| `tool_id` | string | 关联的工具 ID（可选） |

---

## 4. WebSocket 通信（前端 ↔ 后端）

### 4.1 客户端 → 服务端

#### `gemini-command` - 发送命令

```json
{
  "type": "gemini-command",
  "command": "帮我创建一个 React 组件",
  "options": {
    "sessionId": "gemini_1234567890",
    "projectPath": "/Users/xxx/project",
    "cwd": "/Users/xxx/project",
    "model": "gemini-2.5-flash",
    "permissionMode": "auto_edit",
    "debug": false,
    "images": [
      { "data": "data:image/png;base64,iVBOR..." }
    ],
    "sessionSummary": "之前的对话摘要...",
    "toolsSettings": {
      "allowedTools": ["EditFile", "ReadFile"],
      "disallowedTools": ["Shell"],
      "skipPermissions": false
    }
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 固定为 `"gemini-command"` |
| `command` | string | 是 | 用户的提示词/命令 |
| `options.sessionId` | string | 否 | 会话 ID，恢复会话时传入 |
| `options.projectPath` | string | 否 | 项目路径 |
| `options.cwd` | string | 否 | 工作目录 |
| `options.model` | string | 否 | 模型名称 |
| `options.permissionMode` | enum | 否 | `"yolo"` / `"auto_edit"` / `"plan"` |
| `options.images` | array | 否 | Base64 编码的图片数组 |
| `options.sessionSummary` | string | 否 | 会话摘要（用于上下文恢复） |
| `options.toolsSettings` | object | 否 | 工具权限配置 |
| `options.debug` | boolean | 否 | 调试模式 |

#### `gemini-permission-response` - 权限响应

```json
{
  "type": "gemini-permission-response",
  "requestId": "perm_xxx",
  "allow": true,
  "message": ""
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 固定为 `"gemini-permission-response"` |
| `requestId` | string | 是 | 对应权限请求的 ID |
| `allow` | boolean | 是 | `true` 允许，`false` 拒绝 |

#### `abort-session` - 中止会话

```json
{
  "type": "abort-session",
  "sessionId": "gemini_1234567890",
  "provider": "gemini"
}
```

### 4.2 服务端 → 客户端（标准化消息）

所有 Gemini CLI 事件经过标准化后发送给前端，统一格式如下：

#### `session_created` - 会话已创建

```json
{
  "kind": "session_created",
  "newSessionId": "gemini_xxx_new",
  "sessionId": "gemini_xxx",
  "provider": "gemini",
  "id": "msg_xxx",
  "timestamp": "2026-05-15T10:00:00.000Z"
}
```

#### `stream_delta` - 流式文本片段

```json
{
  "kind": "stream_delta",
  "content": "这是一段回复...",
  "sessionId": "gemini_xxx",
  "provider": "gemini",
  "id": "msg_xxx",
  "timestamp": "2026-05-15T10:00:00.000Z"
}
```

#### `tool_use` - 工具调用

```json
{
  "kind": "tool_use",
  "toolName": "EditFile",
  "toolInput": { "path": "/src/index.ts", "content": "..." },
  "toolId": "tool_xxx",
  "sessionId": "gemini_xxx",
  "provider": "gemini",
  "id": "msg_xxx",
  "timestamp": "2026-05-15T10:00:00.000Z"
}
```

#### `tool_result` - 工具结果

```json
{
  "kind": "tool_result",
  "toolId": "tool_xxx",
  "toolResult": {
    "content": "文件已更新",
    "isError": false
  },
  "sessionId": "gemini_xxx",
  "provider": "gemini",
  "id": "msg_xxx",
  "timestamp": "2026-05-15T10:00:00.000Z"
}
```

#### `permission_request` - 权限请求

```json
{
  "kind": "permission_request",
  "requestId": "perm_xxx",
  "toolName": "EditFile",
  "sessionId": "gemini_xxx",
  "provider": "gemini",
  "id": "msg_xxx",
  "timestamp": "2026-05-15T10:00:00.000Z"
}
```

#### `complete` - 完成

```json
{
  "kind": "complete",
  "exitCode": 0,
  "tokens": 1234,
  "sessionId": "gemini_xxx",
  "provider": "gemini",
  "id": "msg_xxx",
  "timestamp": "2026-05-15T10:00:00.000Z"
}
```

#### `error` - 错误

```json
{
  "kind": "error",
  "content": "Rate limit exceeded",
  "sessionId": "gemini_xxx",
  "provider": "gemini",
  "id": "msg_xxx",
  "timestamp": "2026-05-15T10:00:00.000Z"
}
```

---

## 5. 权限/审批处理

### 交互式权限检测

Gemini CLI 在需要用户确认时会输出 TUI（文本用户界面）提示，格式如下：

```
? EditFile  修改文件 /src/index.ts
Apply this change?
  1. Allow once
● 2. Allow for this session
  3. Modify with external editor
  4. No, suggest changes (esc)
```

### 检测方式

`GeminiPermissionDetector` 类通过正则匹配非 JSON 行来检测上述 TUI 模式。

### 响应映射

| 用户选择 | PTY 写入 | 说明 |
|----------|----------|------|
| 允许 (`allow: true`) | `'2\n'` | 选择 "Allow for this session" |
| 拒绝 (`allow: false`) | `'\x1b'` | 发送 ESC 键（= No） |

### 超时

- 120 秒无响应自动拒绝

---

## 6. 会话管理

### 会话 ID 体系

| ID 类型 | 格式 | 来源 | 用途 |
|---------|------|------|------|
| UI 会话 ID | `gemini_<timestamp>` | 前端生成 | WebSocket 通信、前端状态管理 |
| CLI 会话 ID | UUID | Gemini CLI `init` 事件返回 | `--resume` 参数、CLI 内部会话恢复 |

### 会话恢复流程

```
1. 前端发送 gemini-command，options.sessionId 包含已有会话 ID
2. 后端从 sessionManager 查找对应的 cliSessionId
3. 以 --resume <cliSessionId> 启动新的 Gemini CLI 进程
4. Gemini CLI 恢复之前的对话上下文
```

### 存储

- **内存**：`sessionManager` 的 Map，最多 100 个并发会话
- **磁盘**：`~/.gemini/sessions/` 目录

### 会话数据结构

```javascript
{
  id: string,                    // UI 会话 ID
  projectPath: string,           // 项目路径
  cliSessionId?: string,         // Gemini CLI 原生会话 ID
  messages: [
    {
      role: 'user' | 'assistant',
      content: string | Array,   // 文本或工具调用块
      timestamp: Date
    }
  ],
  createdAt: Date,
  lastActivity: Date
}
```

---

## 7. 图片处理

### 流程

```
1. 前端发送 base64 图片数据（options.images 数组）
2. 后端创建临时目录：.tmp/images/<timestamp>/
3. 解码 base64 并写入临时文件
4. 在 prompt 末尾追加图片路径信息：
   [Images given: 2 images are located at:
   1. /path/to/.tmp/images/xxx/image_0.png
   2. /path/to/.tmp/images/xxx/image_1.jpg
   ]
5. Gemini CLI 读取本地图片文件进行处理
6. 进程退出后清理临时文件
```

---

## 8. 错误处理

### 退出码映射

| 退出码 | 含义 | 处理 |
|--------|------|------|
| `0` | 正常完成 | 发送 `complete` 消息 |
| `127` | Gemini CLI 未找到 | 发送特定错误提示 |
| `42` | 输入验证错误 | 发送验证错误消息 |
| 其他 | 通用错误 | 发送通用错误消息 |

### 错误消息解析

- 去除堆栈跟踪信息
- 提取命名错误类型（`ApiError`, `QuotaError`, `TerminalError`）
- 过滤噪音（Node 弃用警告、凭据缓存消息等）

### stderr 噪音过滤

以下内容会被静默忽略：
- Node.js 弃用警告
- `[DEP0040]` 消息

---

## 9. 环境变量与配置

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `GEMINI_PATH` | Gemini CLI 可执行文件路径 | `'gemini'`（系统 PATH） |
| `GEMINI_API_KEY` | API 密钥 | 无（回退到 OAuth） |

### OAuth 凭据

- 路径：`~/.gemini/oauth_creds.json`
- 当 `GEMINI_API_KEY` 未设置时作为降级认证方式

### MCP 配置

- 全局配置：`~/.gemini.json`
- 项目级配置：`.gemini/settings.json`
- 支持传输方式：`stdio`, `http`, `sse`

---

## 10. 进程生命周期

```
1. 生成 (Spawn)
   └─ 创建 PTY 进程，传入 --prompt 和其他参数

2. 初始化 (Init)
   └─ 接收 init 事件，保存 CLI 会话 ID

3. 流式处理 (Stream)
   └─ 逐行解析 JSON 事件，标准化后通过 WebSocket 发送

4. 交互 (Interactive)
   └─ 检测权限提示 → 请求用户确认 → 向 PTY 写入响应

5. 完成 (Complete)
   └─ 进程退出，发送 complete 消息（含退出码和 token 统计）

6. 清理 (Cleanup)
   ├─ 刷新响应处理器缓冲区
   ├─ 保存助手消息到会话
   ├─ 删除临时图片文件
   └─ 从活跃进程 Map 中移除
```

### 超时与清理

- **不活动超时**：120 秒无活动 → 终止进程
- **最大并发会话**：100 个（内存中）

---

## 11. 数据流完整示意

```
用户输入 "帮我创建一个 React 组件"
         │
         ▼
┌─ 前端 WebSocket 发送 ─────────────────────┐
│ { type: "gemini-command",                  │
│   command: "帮我创建一个 React 组件",         │
│   options: { model: "gemini-2.5-flash" } } │
└────────────────────────────────────────────┘
         │
         ▼
┌─ 后端处理 ────────────────────────────────────────────────┐
│ 1. 解析 WebSocket 消息                                     │
│ 2. 构建 CLI 参数：                                         │
│    gemini --model gemini-2.5-flash                        │
│           --output-format stream-json                     │
│           --approval-mode auto_edit                       │
│           --prompt "帮我创建一个 React 组件"                 │
│ 3. 通过 node-pty 生成子进程                                 │
└───────────────────────────────────────────────────────────┘
         │
         ▼
┌─ Gemini CLI stdout 输出（逐行 JSON）──────────────────────┐
│ {"type":"init","session_id":"abc-123-..."}                │
│ {"type":"message","role":"assistant","content":"好的，","delta":true} │
│ {"type":"message","role":"assistant","content":"我来","delta":true}   │
│ {"type":"tool_use","tool_name":"EditFile","tool_id":"t1",...}        │
│ {"type":"tool_result","tool_id":"t1","status":"success",...}         │
│ {"type":"message","role":"assistant","content":"组件已创建。"}         │
│ {"type":"result","stats":{"total_tokens":523}}            │
└───────────────────────────────────────────────────────────┘
         │
         ▼
┌─ GeminiResponseHandler 标准化 ────────────────────────────┐
│ 每个 JSON 事件 → 标准化为 { kind, content, provider, ... } │
│ 通过 WebSocket 逐条发送给前端                                │
└───────────────────────────────────────────────────────────┘
         │
         ▼
┌─ 前端接收并渲染 ──────────────────────────────────────────┐
│ stream_delta → 实时显示文本                                │
│ tool_use     → 显示工具调用卡片                             │
│ tool_result  → 显示执行结果                                │
│ complete     → 标记对话完成                                │
└───────────────────────────────────────────────────────────┘
```
