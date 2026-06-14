## Context

当前 UI 的斜杠命令系统（`/api/commands/list`）仅从两个来源加载命令：硬编码的 8 个内置命令和 `.claude/commands/` 目录下的自定义命令文件。而 Claude CLI 原生还会展示 Skills（`.claude/skills/` 目录下的技能文件），这些 skills 在 UI 中完全不可见。

后端已有完整的 Skills 服务层（`server/modules/providers/services/skills.service.ts`），支持按 provider 和 scope 读取 skills，但该服务仅被 Skills 管理面板使用，未接入斜杠命令系统。

## Goals / Non-Goals

**Goals:**
- 将 Skills 数据源合并到 `/api/commands/list` 返回结果中
- 在 CommandMenu 中以独立分组展示 Skills
- 按当前选择的 provider 加载对应目录的 skills（`.claude/skills/` 或 `.gemini/skills/`）
- 复用已有的 `providerSkillsService`，不重复实现 skills 读取逻辑

**Non-Goals:**
- 不扩展内置命令列表（如 `/compact`, `/vim` 等 CLI 专有命令）
- 不修改 skill 的执行逻辑（选中后仍作为自定义命令提交）
- 不修改 Skills 管理面板（settings 中的 skills UI）

## Decisions

### 1. 复用 `providerSkillsService` 而非重新扫描目录

**选择**: 在 commands.js 中 import 并调用 `providerSkillsService.listSkills()`

**理由**: skills.service.ts 已实现完整的目录扫描逻辑（支持 `.md` 文件和 `SKILL.md` 子目录两种格式），以及 provider 到目录名的映射（`.claude` / `.gemini`）。重新实现会产生重复代码且容易不一致。

**替代方案**: 在 commands.js 中独立实现 skills 扫描 — 代码重复，维护成本高，已否决。

### 2. 通过请求参数传递 provider

**选择**: `/api/commands/list` 请求体新增可选 `provider` 字段

**理由**: Skills 按 provider 存放在不同目录。前端已在 `useChatProviderState` 中维护当前 provider，只需向下透传即可。

### 3. Skills 在菜单中的分组方式

**选择**: 使用 `namespace: 'skill'` 作为独立分组，排序在 User Commands 之后

**理由**: Skills 与自定义命令的来源和用途不同，独立分组便于用户区分。同时保持与 CLI 类似的展示层级。

### 4. Skill 选中后的行为

**选择**: 与自定义命令一致 — 显示 CommandChip，用户可附加文本后提交

**理由**: 已有的 `isBuiltIn` 判断逻辑天然支持，skill 的 `type` 为 `'skill'`、`namespace` 为 `'skill'`，不满足 `type === 'built-in' || namespace === 'builtin'` 条件，会自动走 `onSelectCommand` 路径显示 chip。无需额外修改。

## Risks / Trade-offs

- **[性能]** skills 目录中文件较多时可能增加列表加载时间 → 当前 skills 数量较小（通常 < 20），影响可忽略；且 `listSkills` 已为异步操作
- **[兼容性]** `providerSkillsService` 是 TypeScript 模块，而 commands.js 是纯 JS → 编译后两者均为 JS，import 路径使用编译后路径即可
- **[不支持 skills 的 provider]** cursor / codex 不支持 skills → `providerSkillsService.listSkills()` 会抛出错误 → 需要 try-catch 降级为空列表
