## Why

设置面板已支持全局/项目维度的 MCP 服务管理，但不支持 Skills（自定义技能）的管理。用户需要手动在 `~/.claude/skills/` 或项目 `.claude/skills/` 目录下创建和编辑 `.md` 文件，缺乏可视化界面。Skills 是 Claude Code 的核心扩展机制，应与 MCP 服务享有同等的管理体验。

## What Changes

- 在设置面板 Agents 标签页中新增 "Skills" 子标签（与 Account、Permissions、MCP 并列）
- 支持全局（user）和项目（project）两种 scope 的 Skill 管理
- 支持通过内置编辑器创建/编辑 Skill（Markdown 格式）
- 支持通过文件上传添加 Skill（`.md` 单文件或 `.zip` 压缩包）
- 新增后端 API 端点，实现 Skill 的 CRUD 操作和文件上传
- Skill 列表展示名称、scope、描述摘要，支持删除

## Capabilities

### New Capabilities
- `skill-crud`: Skill 的增删改查 API 和文件系统操作，涵盖全局和项目两种 scope
- `skill-ui`: 设置面板中 Skill 管理的 UI 组件，包括列表、编辑器、上传

### Modified Capabilities

（无需修改已有 spec）

## Impact

- **前端**: 新增 `src/components/skills/` 模块；`AgentCategoryTabsSection` 新增 "skills" 标签；`AgentCategoryContentSection` 新增 Skills 内容渲染
- **后端**: `server/modules/providers/` 下新增 skill 相关路由和服务；复用已有的 multer 上传中间件
- **文件系统**: 读写 `~/.claude/skills/*.md`（全局）和 `<project>/.claude/skills/*.md`（项目级）
- **类型**: 扩展 `AgentCategory` 类型，新增 skill 相关类型定义
- **依赖**: 可能需要 `adm-zip` 或 `unzipper` 处理 zip 解压（需确认现有依赖）
