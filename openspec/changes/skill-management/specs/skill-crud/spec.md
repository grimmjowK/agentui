## ADDED Requirements

### Requirement: 列出 Skills
系统 SHALL 提供 API 端点 `GET /api/providers/:provider/skills`，返回全局和项目两种 scope 下所有 skill 文件的列表。每个 skill 条目 SHALL 包含 `name`（文件名去后缀）、`scope`（user 或 project）、`filename`、`content`（完整 Markdown 内容）。`:provider` 支持 `claude` 和 `gemini`。

#### Scenario: 列出 Claude 全局和项目级 skills
- **WHEN** 请求 `GET /api/providers/claude/skills?workspacePath=/path/to/project`
- **THEN** 系统 SHALL 返回 `{ skills: [...] }`，包含 `~/.claude/skills/*.md` 中的 skill（scope 为 user）和 `<workspacePath>/.claude/skills/*.md` 中的 skill（scope 为 project）

#### Scenario: 列出 Gemini 全局和项目级 skills
- **WHEN** 请求 `GET /api/providers/gemini/skills?workspacePath=/path/to/project`
- **THEN** 系统 SHALL 返回 `{ skills: [...] }`，包含 `~/.gemini/skills/*.md` 中的 skill（scope 为 user）和 `<workspacePath>/.gemini/skills/*.md` 中的 skill（scope 为 project）

#### Scenario: 无 skills 目录时返回空列表
- **WHEN** skills 目录不存在
- **THEN** 系统 SHALL 返回 `{ skills: [] }` 而非报错

#### Scenario: 不支持的 provider
- **WHEN** 请求 `GET /api/providers/cursor/skills`
- **THEN** 系统 SHALL 返回 400 错误，提示该 provider 不支持 skills

### Requirement: 创建或更新 Skill
系统 SHALL 提供 API 端点 `POST /api/providers/:provider/skills`，接收 JSON body `{ name, content, scope, workspacePath? }`，将 Markdown 内容写入对应 provider 和 scope 的 skills 目录。

#### Scenario: 创建新的全局 skill（Claude）
- **WHEN** 请求 `POST /api/providers/claude/skills`，body 为 `{ name: "my-skill", content: "# My Skill\n...", scope: "user" }`
- **THEN** 系统 SHALL 将内容写入 `~/.claude/skills/my-skill.md`，如目录不存在则自动创建

#### Scenario: 创建新的全局 skill（Gemini）
- **WHEN** 请求 `POST /api/providers/gemini/skills`，body 为 `{ name: "my-skill", content: "...", scope: "user" }`
- **THEN** 系统 SHALL 将内容写入 `~/.gemini/skills/my-skill.md`

#### Scenario: 更新已有的项目级 skill
- **WHEN** 请求 body 为 `{ name: "existing-skill", content: "updated content", scope: "project", workspacePath: "/path" }`
- **THEN** 系统 SHALL 覆盖写入 `<workspacePath>/.<provider>/skills/existing-skill.md`

#### Scenario: 名称自动规范化
- **WHEN** name 包含空格或大写字母（如 "My Custom Skill"）
- **THEN** 系统 SHALL 将名称转换为 kebab-case 作为文件名（`my-custom-skill.md`）

### Requirement: 删除 Skill
系统 SHALL 提供 API 端点 `DELETE /api/providers/:provider/skills/:name`，删除指定 scope 下的 skill 文件。

#### Scenario: 删除全局 skill
- **WHEN** 请求 `DELETE /api/providers/claude/skills/my-skill?scope=user`
- **THEN** 系统 SHALL 删除 `~/.claude/skills/my-skill.md` 并返回成功

#### Scenario: 删除不存在的 skill
- **WHEN** 请求删除的文件不存在
- **THEN** 系统 SHALL 返回 404 错误

### Requirement: 上传 Skill 文件
系统 SHALL 提供 API 端点 `POST /api/providers/:provider/skills/upload`，接收 `.md` 或 `.zip` 文件上传。

#### Scenario: 上传单个 .md 文件
- **WHEN** 用户上传一个 `.md` 文件，scope 为 user，provider 为 claude
- **THEN** 系统 SHALL 将文件保存到 `~/.claude/skills/` 目录，文件名保持原始名称

#### Scenario: 上传 .zip 压缩包
- **WHEN** 用户上传一个 `.zip` 文件，scope 为 project，provider 为 gemini
- **THEN** 系统 SHALL 解压 zip，仅提取其中的 `.md` 文件，保存到 `<workspacePath>/.gemini/skills/` 目录

#### Scenario: zip 中非 .md 文件被忽略
- **WHEN** zip 中包含 `.txt`、`.js` 等非 `.md` 文件
- **THEN** 系统 SHALL 忽略这些文件，仅处理 `.md` 文件

#### Scenario: 路径遍历攻击防护
- **WHEN** zip 中包含 `../../etc/passwd` 等路径遍历的文件名
- **THEN** 系统 SHALL 拒绝该文件并返回错误

### Requirement: Skill 名称不可含路径分隔符
系统 SHALL 校验 skill 名称不包含 `/`、`\`、`..` 等路径分隔符或遍历字符。

#### Scenario: 包含路径分隔符的名称
- **WHEN** 创建 skill 时 name 为 `../hack`
- **THEN** 系统 SHALL 返回 400 错误
