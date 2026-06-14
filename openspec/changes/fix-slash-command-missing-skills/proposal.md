## Why

在 UI 聊天输入框输入 `/` 时，展示的命令列表远少于 Claude CLI 原生展示的内容。根本原因是 `/api/commands/list` 端点只返回了内置命令和 `.claude/commands/` 自定义命令，完全遗漏了 Skills（技能）。当前环境中有 10 个用户级 skill 和 4 个项目级 skill，这些在 CLI 的 `/` 菜单中都会出现但在 UI 中完全不可见，导致用户体验断裂。

## What Changes

- 后端 `/api/commands/list` 端点新增 skills 数据源，复用已有的 `providerSkillsService.listSkills()` 方法
- 请求体新增可选 `provider` 参数，用于按 provider 加载对应目录下的 skills
- 前端 `useSlashCommands` hook 传递 provider 参数并合并 skills 到命令列表
- `CommandMenu` 组件新增 `skill` 命名空间分组，展示 Skills 分类

## Capabilities

### New Capabilities
- `slash-command-skills-integration`: 将 Skills 集成到斜杠命令菜单中，用户输入 `/` 时可以看到并选择已安装的 skills

### Modified Capabilities

（无需修改已有 spec 的需求）

## Impact

- **后端**: `server/routes/commands.js` — 新增 skills 数据源合并逻辑
- **前端 Hook**: `src/components/chat/hooks/useSlashCommands.ts` — 传递 provider、合并 skills
- **前端组件**: `src/components/chat/view/subcomponents/CommandMenu.tsx` — 新增 skill 分组样式
- **前端状态**: `src/components/chat/hooks/useChatComposerState.ts` — 向 hook 传递 provider
- **依赖**: 复用已有的 `providerSkillsService`（`server/modules/providers/services/skills.service.ts`），无需新增依赖
