# src/components — 组件模块索引

本目录按功能模块组织 React 组件。每个模块内部通常遵循五段式约定：
`types/`（类型）、`constants/`（常量）、`hooks/`（自定义 Hooks）、`utils/`（工具函数）、`view/`（视图组件）。
AI 调整某模块时，可只加载对应模块目录，无需通读全部。

## 模块清单

| 模块 | 职责 |
| --- | --- |
| `app/` | 应用主容器，整合侧边栏、主内容区和命令面板的顶层结构 |
| `auth/` | 处理用户登录、注册和身份验证的认证模块（含 `context/`、`view/`） |
| `chat/` | 对话聊天界面，与 LLM 提供商交互的主要功能模块（含 `tools/`） |
| `code-editor/` | 集成 CodeMirror 的代码编辑器，支持多语言及 diff 查看 |
| `command-palette/` | 快速命令搜索和执行的命令面板（含 `sources/` 命令来源） |
| `file-tree/` | 项目文件树展示和文件操作管理 |
| `git-panel/` | Git 仓库状态、分支、历史和改动的可视化面板 |
| `llm-logo-provider/` | LLM 提供商（Claude、Gemini 等）的 logo 组件库 |
| `main-content/` | 主内容区域，聚合聊天、编辑器、终端等子模块 |
| `mcp/` | 管理和配置 MCP 服务器 |
| `onboarding/` | 新用户引导流程，含 Git 与代理连接配置 |
| `plugins/` | 第三方插件管理和渲染的插件系统 |
| `prd-editor/` | PRD 文档编辑器，支持创建和编辑项目需求文档 |
| `project-creation-wizard/` | 项目创建向导，支持本地和 GitHub 克隆工作流（含 `components/`、`data/`） |
| `provider-auth/` | LLM 提供商认证和授权的模态框组件 |
| `quick-settings-panel/` | 浮动快速设置面板，可拖拽调整常用偏好 |
| `settings/` | 应用全局设置中心，管理代理、凭证、主题等配置 |
| `shell/` | 集成 xterm 的终端组件，提供交互式命令执行环境 |
| `sidebar/` | 左侧边栏，展示项目列表和导航菜单的主导航面板 |
| `skills/` | 技能模块管理，创建、编辑和上传 AI 技能定义 |
| `standalone-shell/` | 独立终端组件，可在模态框或其他上下文中使用 |
| `task-master/` | 任务管理系统，支持任务看板和 PRD 关联（含 `context/`） |
| `version-upgrade/` | 版本升级通知和安装流程的模态框 |
