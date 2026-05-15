# GEMINI.md - Gemini AI 助手指南

本文档旨在帮助 Gemini AI 助手快速了解 CloudCLI UI 项目，并提供协作开发的最佳实践。

## 基础规范

- **所有回复和代码注释**：使用中文
- **代码风格**：Go 遵循 goimports 格式化，使用 `goimports -w` 进行代码格式化

## 项目概述

**CloudCLI UI** (又名 Claude Code UI) 是一个为多种 AI 编程助手提供桌面和移动端 UI 的开源项目：
- Claude Code (Anthropic)
- Cursor CLI
- OpenAI Codex
- Gemini CLI

用户可以在本地或远程使用它来管理活跃的项目和会话。

## 技术栈

### 前端 (`src/`)
| 技术 | 版本 | 用途 |
|------|------|------|
| React | 18 | UI 框架 |
| TypeScript | 5.9+ | 类型安全 |
| Vite | 7 | 构建工具 |
| Tailwind CSS | 3.4 | 样式框架 |
| CodeMirror | 6 | 代码编辑器 |
| xterm.js | 5.5 | 终端模拟 |
| i18next | 25+ | 国际化 |
| react-router-dom | 6 | 路由管理 |

### 后端 (`server/`)
| 技术 | 版本 | 用途 |
|------|------|------|
| Node.js | 22+ | 运行时 |
| Express | 4 | Web 框架 |
| SQLite | - | 数据库 (better-sqlite3) |
| WebSocket | ws 8+ | 实时通信 |
| claude-agent-sdk | 0.2+ | Claude AI 集成 |
| codex-sdk | 0.101+ | OpenAI Codex 集成 |

### 共享代码 (`shared/`)
- `modelConstants.js` - AI 模型常量定义
- `networkHosts.js` - 网络主机配置

## 项目结构

```
claudecodeui/
├── src/                    # React 前端
│   ├── components/         # UI 组件 (按功能模块组织)
│   │   ├── chat/          # 聊天界面
│   │   ├── sidebar/       # 侧边栏导航
│   │   ├── shell/         # 终端模拟器
│   │   ├── code-editor/   # 代码编辑器
│   │   ├── file-tree/     # 文件浏览器
│   │   ├── git-panel/     # Git 版本控制
│   │   ├── settings/      # 设置面板
│   │   ├── plugins/       # 插件管理
│   │   ├── auth/          # 认证组件
│   │   └── mcp/           # MCP 配置
│   ├── contexts/          # React Context (状态共享)
│   ├── hooks/             # 自定义 React Hooks
│   ├── i18n/              # 国际化 (多语言支持)
│   ├── stores/            # Zustand 状态管理
│   ├── types/             # TypeScript 类型
│   └── utils/             # 工具函数
├── server/                 # Express 后端服务
│   ├── routes/            # REST API 端点
│   ├── middleware/        # 中间件 (认证等)
│   ├── database/          # 数据库操作
│   ├── modules/           # 业务模块
│   │   └── providers/     # AI 提供商集成
│   ├── services/          # 服务层
│   └── utils/             # 服务端工具
├── shared/                 # 前后端共享代码
├── public/                 # 静态资源
├── plugins/                # 插件示例
├── docker/                 # Docker 容器配置
│   ├── claude-code/       # Claude Code 镜像
│   ├── gemini/            # Gemini CLI 镜像
│   └── codex/             # Codex 镜像
└── openspec/               # 规范文档
```

## 开发指南

### 环境要求
- Node.js 22 或更高版本
- npm (随 Node.js 安装)
- 至少一个 AI CLI 工具 (Claude Code, Gemini CLI, Cursor CLI, 或 Codex)

### 快速开始
```bash
# 1. 克隆项目
git clone https://github.com/siteboon/claudecodeui.git
cd claudecodeui

# 2. 安装依赖
npm install

# 3. 启动开发服务器
npm run dev

# 4. 访问 http://localhost:3001
```

### 常用命令
| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式 (前后端热重载) |
| `npm run build` | 生产构建 |
| `npm run server:dev` | 仅启动后端 |
| `npm run client` | 仅启动前端 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint 代码检查 |
| `npm run lint:fix` | 自动修复 lint 问题 |

## 代码规范

### 提交消息格式
项目使用 [Conventional Commits](https://conventionalcommits.org/) 规范：

```
<类型>(<作用域>): <描述>

# 类型说明
feat     - 新功能
fix      - Bug 修复
perf     - 性能优化
refactor - 代码重构
docs     - 文档更新
style    - 样式修改
chore    - 维护任务
ci       - CI/CD 更新
test     - 测试相关
build    - 构建系统

# 示例
feat(chat): add message search functionality
fix(shell): resolve terminal resize issue
docs: update API documentation
```

### TypeScript 规范
- **严格模式**: 启用 `strict: true`
- **路径别名**: 
  - 前端: `@/*` → `src/*`
  - 后端: 独立配置在 `server/tsconfig.json`
- **类型优先**: 新代码必须使用 TypeScript

### 组件开发规范
每个功能模块遵循统一结构：
```
src/components/<module>/
├── types/       # 类型定义
├── constants/   # 常量
├── hooks/       # 自定义 Hooks
├── utils/       # 工具函数
└── view/        # 视图组件
```

## AI 协作指南

### 修改代码前请确认
1. **理解上下文**: 先阅读相关文件了解现有实现
2. **遵循模式**: 参考相似功能的实现方式
3. **类型安全**: 确保添加正确的 TypeScript 类型
4. **国际化**: UI 文本使用 i18next (`src/i18n/locales/`)

### 常见任务指南

#### 添加新的 API 端点
1. 在 `server/routes/` 创建或修改路由文件
2. 在 `server/routes/index.js` 注册路由
3. 添加必要的中间件和验证

#### 添加新的 UI 组件
1. 在 `src/components/` 相应目录创建组件
2. 遵循模块结构 (types, hooks, view 等)
3. 导出组件供其他模块使用

#### 添加新语言支持
1. 在 `src/i18n/locales/` 添加语言文件
2. 在 `src/i18n/config.js` 注册新语言
3. 更新 `src/i18n/languages.js`

### 验证修改
```bash
# 类型检查 - 确保无类型错误
npm run typecheck

# 代码规范 - 确保符合 ESLint 规则
npm run lint

# 构建测试 - 确保生产构建成功
npm run build
```

## 重要文件索引

| 用途 | 文件路径 |
|------|----------|
| 入口组件 | `src/App.tsx` |
| 路由配置 | `src/main.jsx` |
| 全局样式 | `src/index.css` |
| API 路由 | `server/routes/*.js` |
| 数据库 | `server/database/` |
| AI 模型配置 | `shared/modelConstants.js` |
| 环境变量示例 | `.env.example` |
| 构建配置 | `vite.config.js` |

## 安全注意事项

1. **工具权限**: 所有 AI 工具默认禁用，需用户手动启用
2. **认证**: 使用 JWT + bcrypt 进行用户认证
3. **配置同步**: UI 配置与 `~/.claude` 目录双向同步

## 许可证

**AGPL-3.0-or-later** - 开源许可证

⚠️ 重要: 如果修改此软件并作为网络服务运行，必须公开修改后的源代码。

## 资源链接

| 资源 | 链接 |
|------|------|
| 官方文档 | https://cloudcli.ai/docs |
| GitHub 仓库 | https://github.com/siteboon/claudecodeui |
| Discord 社区 | https://discord.gg/buxwujPNRE |
| 问题反馈 | https://github.com/siteboon/claudecodeui/issues |
| 贡献指南 | [CONTRIBUTING.md](./CONTRIBUTING.md) |
