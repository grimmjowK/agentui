## 1. 后端：新增 CLI 会话删除函数

- [x] 1.1 在 `server/projects.js` 中新增 `deleteGeminiCliSession(sessionId)` 函数，遍历 `~/.gemini/tmp/` 下所有项目目录的 `chats/` 子目录，查找并删除匹配 `{sessionId}.json` 的文件
- [x] 1.2 将 `deleteGeminiCliSession` 添加到 `server/projects.js` 的导出列表中

## 2. 后端：修改 DELETE 路由

- [x] 2.1 在 `server/routes/gemini.js` 中引入 `deleteGeminiCliSession`
- [x] 2.2 在 DELETE handler 中，在现有 `sessionManager.deleteSession()` 之后调用 `deleteGeminiCliSession(sessionId)`，用 try-catch 包裹确保 CLI 文件删除失败不影响整体删除操作

## 3. 验证

- [ ] 3.1 手动测试：创建 Gemini 会话 → 删除 → 刷新页面，确认会话不再出现
- [x] 3.2 确认删除不存在的 CLI 会话文件时不报错
