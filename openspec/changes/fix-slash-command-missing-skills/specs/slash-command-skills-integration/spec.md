## ADDED Requirements

### Requirement: 斜杠命令列表包含 Skills

`/api/commands/list` 端点 SHALL 返回当前 provider 对应目录下的所有 skills，与内置命令和自定义命令合并在同一列表中。每个 skill 条目 MUST 包含 `name`（以 `/` 前缀）、`description`（来自 SKILL.md frontmatter）、`namespace`（值为 `'skill'`）和 `metadata.type`（值为 `'skill'`）。

#### Scenario: Claude provider 加载 skills
- **WHEN** 前端以 `provider: 'claude'` 调用 `/api/commands/list`
- **THEN** 返回结果中包含 `~/.claude/skills/` 和 `<projectPath>/.claude/skills/` 下的所有 skills

#### Scenario: Gemini provider 加载 skills
- **WHEN** 前端以 `provider: 'gemini'` 调用 `/api/commands/list`
- **THEN** 返回结果中包含 `~/.gemini/skills/` 和 `<projectPath>/.gemini/skills/` 下的所有 skills

#### Scenario: 不支持 skills 的 provider 降级
- **WHEN** 前端以 `provider: 'cursor'` 或 `provider: 'codex'` 调用 `/api/commands/list`
- **THEN** 返回结果中不包含 skills，且不产生错误

#### Scenario: 未传递 provider 参数
- **WHEN** 前端未传递 `provider` 参数
- **THEN** 默认使用 `'claude'` 加载 skills

### Requirement: CommandMenu 展示 Skills 分组

CommandMenu 组件 SHALL 将 `namespace` 为 `'skill'` 的命令渲染为独立分组，分组标签为 `'Skills'`，图标为 `[S]`。分组 MUST 排列在 User Commands 之后、Other Commands 之前。

#### Scenario: 存在 skills 时展示分组
- **WHEN** 命令列表中包含 `namespace: 'skill'` 的条目
- **THEN** CommandMenu 显示 "Skills" 分组头，其下列出所有 skill 条目

#### Scenario: 无 skills 时不展示空分组
- **WHEN** 命令列表中不包含 `namespace: 'skill'` 的条目
- **THEN** CommandMenu 不显示 "Skills" 分组头

### Requirement: Skill 选中后显示 CommandChip

选中一个 skill 后，系统 SHALL 以 CommandChip 形式展示在输入框中，与自定义命令行为一致。用户可附加文本后提交。

#### Scenario: 从菜单选择 skill
- **WHEN** 用户在 CommandMenu 中点击或回车选择一个 skill
- **THEN** 输入框顶部出现 CommandChip 显示 skill 名称，输入框清空可继续输入附加文本

### Requirement: provider 切换时刷新 skills 列表

当用户切换 provider 时，斜杠命令列表 SHALL 重新加载以反映新 provider 对应的 skills。

#### Scenario: 从 claude 切换到 gemini
- **WHEN** 用户将 provider 从 claude 切换为 gemini
- **THEN** 斜杠命令列表刷新，skills 部分显示 `.gemini/skills/` 下的内容
