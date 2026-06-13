## Context

当前 Gemini 会话存储在两个位置：
1. **UI 会话** — `~/.gemini/sessions/{sessionId}.json`，由 `sessionManager` 管理
2. **CLI 会话** — `~/.gemini/tmp/{hashedProjectDir}/chats/{sessionId}.json`，由 Gemini CLI 创建

加载时（`server/projects.js:487-490`），两个来源被合并：
```js
const uiSessions = sessionManager.getProjectSessions(actualProjectDir) || [];
const cliSessions = await getGeminiCliSessions(actualProjectDir);
project.geminiSessions = [...uiSessions, ...cliSessions.filter(s => !uiIds.has(s.id))];
```

删除时（`server/routes/gemini.js:15`），只调用 `sessionManager.deleteSession(sessionId)`，仅删除 `~/.gemini/sessions/` 下的文件。CLI 会话文件未被处理，刷新后重新出现。

## Goals / Non-Goals

**Goals:**
- 删除 Gemini 会话时同时清理 CLI 会话文件
- 保持现有前端 API 调用方式不变
- 保持删除操作的幂等性和安全性

**Non-Goals:**
- 不修改 Gemini CLI 本身的行为
- 不改变会话加载/合并逻辑
- 不处理其他 provider（Claude/Cursor/Codex）的会话删除

## Decisions

### 决策 1：在 DELETE route 中增加 CLI 文件删除逻辑

**选择**: 在 `server/routes/gemini.js` 的 DELETE handler 中，调用一个新函数来删除 CLI 会话文件。

**替代方案**:
- A) 修改 `sessionManager.deleteSession()` — 不合适，因为 sessionManager 不知道项目路径，也不应该了解 CLI 会话的存储结构
- B) 在前端传递 projectPath 参数 — 增加 API 复杂度，且前端不应关心后端存储细节

**理由**: route handler 是唯一同时拥有 sessionId 和可以访问 projects.js 功能的地方，最小变更。

### 决策 2：在 projects.js 中新增 `deleteGeminiCliSession` 函数

**选择**: 在已有 `getGeminiCliSessions` 的同一模块中新增删除函数，复用 `~/.gemini/tmp/` 遍历逻辑。

**理由**: `projects.js` 已经封装了 CLI 会话目录的发现逻辑（遍历 `~/.gemini/tmp/` 下的项目目录，读取 `.project_root`，匹配 `chats/` 下的文件），新增删除函数只需在发现匹配文件后执行 `unlink` 而非 `readFile`。

### 决策 3：不需要 projectPath 参数

**选择**: 遍历 `~/.gemini/tmp/` 下所有项目目录查找并删除匹配的 sessionId 文件。

**理由**: sessionId 在所有项目中应当唯一（基于 UUID/时间戳），遍历所有目录可以确保完全清理，且无需修改前端 API。

## Risks / Trade-offs

- **[遍历性能]** → 遍历 `~/.gemini/tmp/` 下所有项目目录有轻微 I/O 开销。**缓解**: 通常项目数量有限（<50），且删除操作低频，影响可忽略。
- **[文件权限]** → CLI 创建的文件可能有不同权限。**缓解**: Node.js `fs.unlink` 只需写权限到父目录，通常同一用户运行不会有问题。对 `unlink` 失败做 graceful 处理。
- **[并发安全]** → Gemini CLI 可能正在写入该文件。**缓解**: 删除操作是原子的（unlink），不会导致数据损坏；最坏情况是 CLI 重新创建文件。
