## Context

设置面板已有完整的 MCP 服务管理系统，包括：
- Provider 级别的路由 (`/api/providers/:provider/mcp/servers`)
- 抽象基类 `BaseMcpProvider` 和 provider 特定实现
- 前端 `useMcpServers` Hook + `McpServers` UI 组件
- 支持 user/project/local 三种 scope

Skills 是 CLI 的扩展机制，以 `.md` 文件形式存储在不同 provider 对应的目录下：
- Claude 全局：`~/.claude/skills/*.md`，项目：`<project>/.claude/skills/*.md`
- Gemini 全局：`~/.gemini/skills/*.md`，项目：`<project>/.gemini/skills/*.md`

目前没有任何 Skill 管理代码。项目已有 multer 文件上传中间件，可复用。

## Goals / Non-Goals

**Goals:**
- 在设置面板的 Agents 标签中新增 Skills 子标签，提供 Skill 的可视化管理
- 支持 Claude 和 Gemini 两种 Agent 的 Skill 管理
- 支持全局（user）和项目（project）两种 scope 的 Skill CRUD
- 支持在线编辑 Markdown 内容创建/修改 Skill
- 支持上传 `.md` 文件或 `.zip` 压缩包添加 Skill
- 列表展示 Skill 名称、scope 来源、内容摘要

**Non-Goals:**
- 不实现 Cursor/Codex 的 Skill 管理（目前仅 Claude 和 Gemini 支持 Skills）
- 不实现 Skill 的版本管理或回滚
- 不实现 Skill 市场或共享机制
- 不实现 Skill 的启用/禁用开关（文件存在即启用）

## Decisions

### 1. Claude 和 Gemini 支持 Skills

**选择**：Skills 标签在选中 Claude 或 Gemini 时显示内容，Cursor/Codex 显示"不支持"提示。

**理由**：Claude Code CLI 和 Gemini CLI 都支持 skills 机制，区别仅在于文件存储目录不同（`.claude/skills/` vs `.gemini/skills/`）。

### 2. 直接操作文件系统，不使用数据库

**选择**：后端 API 直接读写对应 provider 的 skills 目录，不引入数据库存储。

**理由**：与 CLI 保持一致，CLI 直接读取这些文件。数据库会引入同步问题。

### 3. API 路由设计：挂载到 providers 路由下，支持多 provider

**选择**：
- `GET /api/providers/:provider/skills` — 列出所有 skills（含 user 和 project scope）
- `POST /api/providers/:provider/skills` — 创建/更新 skill（JSON body 含 name、content、scope）
- `DELETE /api/providers/:provider/skills/:name` — 删除 skill
- `POST /api/providers/:provider/skills/upload` — 上传 .md 或 .zip 文件

其中 `:provider` 支持 `claude` 和 `gemini`。provider 到目录的映射：
- `claude` → `.claude/skills/`
- `gemini` → `.gemini/skills/`

**理由**：与 MCP 路由风格一致（`/api/providers/:provider/mcp/servers`），且天然支持多 provider 扩展。

### 4. Zip 解压方案

**选择**：使用 Node.js 内置的 `node:zlib` + `tar` 或轻量级 `adm-zip` 库解压 zip 文件，提取其中的 `.md` 文件写入 skills 目录。

**理由**：zip 上传是批量导入 skill 的主要场景，需要支持。优先使用已有依赖或轻量库。

### 5. Skill 编辑器

**选择**：在创建/编辑 Modal 中使用纯文本 `<textarea>` 或项目已有的 CodeMirror 编辑器（Markdown 模式）。

**理由**：项目已集成 CodeMirror 6，可复用 Markdown 语言支持。

### 6. Skill 文件命名

**选择**：skill 文件名使用 kebab-case，后缀 `.md`。用户输入的名称自动转换为文件名（如 "My Custom Skill" → `my-custom-skill.md`）。

## Risks / Trade-offs

- **[风险] 文件系统权限不足** → API 层捕获 EACCES 错误并返回用户友好的错误信息
- **[风险] Zip 中包含非 .md 文件或恶意路径** → 解压时仅提取 `.md` 文件，忽略其他；路径校验防止目录遍历攻击
- **[风险] 大文件上传** → 复用现有 multer 的 50MB 限制，zip 解压后单文件限制 1MB
- **[权衡] Cursor/Codex 不支持** → 其他 Agent 的 Skills 标签显示提示文案，未来可扩展
