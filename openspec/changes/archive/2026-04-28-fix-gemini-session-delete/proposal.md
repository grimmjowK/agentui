## Why

Gemini 对话历史删除后会在页面刷新时重新出现。根本原因是 Gemini 的会话存储在两个位置（UI 管理的 `~/.gemini/sessions/` 和 CLI 生成的 `~/.gemini/tmp/{projectDir}/chats/`），而当前的删除接口只清理了 UI 侧的会话文件，CLI 侧的 `.json` 文件从未被删除，导致下次加载时被重新发现并合并回列表。

## What Changes

- 修复 Gemini 会话删除接口，使其同时删除 CLI 生成的会话文件（`~/.gemini/tmp/{projectDir}/chats/{sessionId}.json`）
- 在 `sessionManager.deleteSession()` 或 DELETE route 中增加对 CLI 会话文件的查找与删除逻辑
- 确保删除操作覆盖所有 project 目录下可能存在的同名会话文件

## Capabilities

### New Capabilities
- `gemini-cli-session-cleanup`: 在删除 Gemini 会话时，同时定位并删除 `~/.gemini/tmp/` 下对应的 CLI 会话 JSON 文件，确保删除操作的完整性

### Modified Capabilities
<!-- 无现有 spec 需要修改 -->

## Impact

- **后端路由**: `server/routes/gemini.js` — DELETE `/api/gemini/sessions/:sessionId` 需要扩展删除逻辑
- **会话管理器**: `server/sessionManager.js` 或 `server/projects.js` — 需要新增 CLI 会话文件定位与删除功能
- **文件系统**: 会删除 `~/.gemini/tmp/{projectDir}/chats/` 下的 `.json` 文件
- **无 Breaking Change**: 前端调用方式不变，仅后端增强删除覆盖范围
