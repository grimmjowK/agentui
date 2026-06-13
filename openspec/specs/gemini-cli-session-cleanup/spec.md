# Gemini CLI Session Cleanup

## Purpose

Ensure Gemini 会话删除操作完整清理磁盘上的所有对应文件，避免已删除会话在页面刷新后重新出现。

## Requirements

### Requirement: Delete Gemini CLI session file on session deletion
当用户通过 API 删除 Gemini 会话时，系统 SHALL 同时查找并删除 `~/.gemini/tmp/` 下对应的 CLI 会话 JSON 文件，确保会话不会在页面刷新后重新出现。

#### Scenario: Delete a CLI-generated Gemini session
- **WHEN** 用户删除一个由 Gemini CLI 创建的会话（文件位于 `~/.gemini/tmp/{projectDir}/chats/{sessionId}.json`）
- **THEN** 系统 SHALL 遍历 `~/.gemini/tmp/` 下所有项目目录，找到并删除匹配 sessionId 的 `.json` 文件

#### Scenario: Delete a UI-generated Gemini session
- **WHEN** 用户删除一个由 UI 创建的会话（文件位于 `~/.gemini/sessions/{sessionId}.json`）
- **THEN** 系统 SHALL 同时尝试删除 `~/.gemini/sessions/` 和 `~/.gemini/tmp/` 两个位置中的对应文件（即使其中一个不存在也不报错）

#### Scenario: Session file not found in CLI directory
- **WHEN** 用户删除一个在 `~/.gemini/tmp/` 下不存在对应文件的会话
- **THEN** 系统 SHALL 静默处理（不抛出错误），删除操作仍返回成功

#### Scenario: Page refresh after deletion
- **WHEN** 用户删除 Gemini 会话后刷新页面
- **THEN** 被删除的会话 SHALL NOT 重新出现在会话列表中
