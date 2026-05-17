## ADDED Requirements

### Requirement: Skills 标签页
设置面板的 Agent 类别标签 SHALL 新增 "Skills" 标签，与 Account、Permissions、MCP 并列。

#### Scenario: 选中 Claude 或 Gemini 时展示 Skills 内容
- **WHEN** 用户选中 Claude 或 Gemini Agent 并点击 Skills 标签
- **THEN** 系统 SHALL 展示 Skill 列表，包含全局和项目两种 scope 的 skill

#### Scenario: 选中 Cursor/Codex 时展示提示
- **WHEN** 用户选中 Cursor/Codex 并点击 Skills 标签
- **THEN** 系统 SHALL 展示提示信息，说明当前 Agent 不支持 Skills

### Requirement: Skill 列表展示
Skill 列表 SHALL 展示每个 skill 的名称、scope 标识（全局/项目）、以及内容摘要（首行或前 80 字符）。

#### Scenario: 列表按 scope 分组
- **WHEN** 同时存在全局和项目级 skill
- **THEN** 列表 SHALL 按 scope 分组展示，全局（User）在前，项目（Project）在后

#### Scenario: 空列表提示
- **WHEN** 没有任何 skill
- **THEN** 系统 SHALL 展示空状态提示和创建引导

### Requirement: 创建 Skill
系统 SHALL 提供创建 Skill 的入口，打开一个 Modal 对话框，包含名称输入、scope 选择、Markdown 编辑器。

#### Scenario: 通过编辑器创建 skill
- **WHEN** 用户填写名称、选择 scope、在编辑器中输入 Markdown 内容并点击保存
- **THEN** 系统 SHALL 调用 API 创建 skill 并刷新列表

#### Scenario: 名称为空时阻止提交
- **WHEN** 用户未填写名称即点击保存
- **THEN** 系统 SHALL 阻止提交并高亮名称输入框

### Requirement: 编辑 Skill
系统 SHALL 支持点击 skill 条目进入编辑模式，在 Modal 中展示该 skill 的 Markdown 内容。

#### Scenario: 编辑已有 skill
- **WHEN** 用户点击某个 skill 的编辑按钮
- **THEN** 系统 SHALL 打开 Modal，预填 name（只读）、scope（只读）、和当前 content

#### Scenario: 保存编辑后的 skill
- **WHEN** 用户修改 Markdown 内容并点击保存
- **THEN** 系统 SHALL 调用 API 更新内容并刷新列表

### Requirement: 删除 Skill
系统 SHALL 支持删除 skill，需用户确认。

#### Scenario: 确认后删除
- **WHEN** 用户点击删除按钮并确认
- **THEN** 系统 SHALL 调用 API 删除 skill 文件并从列表中移除

### Requirement: 上传 Skill 文件
系统 SHALL 提供文件上传入口，支持 `.md` 和 `.zip` 文件。

#### Scenario: 上传 .md 文件
- **WHEN** 用户选择一个 `.md` 文件和目标 scope 并上传
- **THEN** 系统 SHALL 调用上传 API，成功后刷新列表

#### Scenario: 上传 .zip 文件
- **WHEN** 用户选择一个 `.zip` 文件并上传
- **THEN** 系统 SHALL 调用上传 API，后端解压提取 `.md` 文件，成功后刷新列表并显示导入的文件数量

#### Scenario: 文件类型校验
- **WHEN** 用户尝试上传非 `.md` 或 `.zip` 的文件
- **THEN** 系统 SHALL 阻止上传并提示仅支持 `.md` 和 `.zip` 文件
