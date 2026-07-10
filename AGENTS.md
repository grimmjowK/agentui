# AGENTS.md - Codex AI 助手指南

本文档旨在帮助 Codex AI 助手快速了解 CloudCLI UI 项目，并提供协作开发的最佳实践。

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
- **框架**: React 18 + TypeScript
- **构建工具**: Vite 7
- **样式**: Tailwind CSS 3.4
- **代码编辑器**: CodeMirror 6
- **终端**: xterm.js
- **国际化**: i18next
- **路由**: react-router-dom

### 后端 (`server/`)
- **运行时**: Node.js 22+
- **框架**: Express 4
- **数据库**: SQLite (better-sqlite3)
- **WebSocket**: ws
- **AI SDK**:
    - @anthropic-ai/claude-agent-sdk
    - @openai/codex-sdk

### 共享代码 (`shared/`)
- 模型常量定义
- 网络主机配置
- 客户端和服务端共用的类型

## 项目结构

```
claudecodeui/
├── src/                    # React 前端 → 详见 src/SRC.md
│   ├── components/         # UI 组件 (22 个功能模块) → 详见 src/components/COMPONENTS.md
│   ├── contexts/          # React Context 提供者
│   ├── hooks/             # 自定义 Hooks
│   ├── stores/            # 状态管理 (Zustand)
│   ├── i18n/              # 国际化配置和翻译文件
│   ├── types/             # TypeScript 类型定义
│   ├── lib/              # 样式工具库 (cn / safeJsonParse)
│   ├── shared/           # 通用 UI 组件库与基础类型
│   ├── constants/        # 应用配置常量
│   └── utils/             # 工具函数
├── server/                 # Express + WebSocket 后端 → 详见 server/SERVER.md
│   ├── *.js               # 各 AI provider 的 CLI/SDK 适配 (claude-sdk/gemini-cli/cursor-cli/openai-codex 等)
│   ├── routes/            # HTTP 路由处理器
│   ├── middleware/        # Express 中间件
│   ├── database/          # SQLite 数据库层
│   ├── modules/           # 模块化业务核心 → 详见 server/modules/MODULES.md
│   ├── services/          # 服务层
│   ├── shared/            # 服务端共享类型与工具
│   └── utils/             # 服务端工具
├── shared/                 # 客户端/服务端共享代码 (模型常量、网络主机)
├── public/                 # 静态资源、图标、PWA manifest
├── plugins/                # 插件系统示例
├── docker/                 # Docker 配置 (沙箱环境)
└── openspec/               # OpenSpec 规范文档
```

### 渐进式文档导航

为支持按需加载，各关键目录下设有结构索引文件。调整对应功能时，**先加载就近的索引文件**，再深入具体目录：

| 索引文件 | 覆盖范围 |
| --- | --- |
| [`src/SRC.md`](src/SRC.md) | 前端顶层目录 (contexts/hooks/stores/lib/shared 等) |
| [`src/components/COMPONENTS.md`](src/components/COMPONENTS.md) | 22 个 UI 组件模块的职责清单 |
| [`server/SERVER.md`](server/SERVER.md) | 后端根文件 (provider 适配) 与子目录 |
| [`server/modules/MODULES.md`](server/modules/MODULES.md) | database/projects/providers/websocket 模块及内部分层 |

> 注：每个 `src/components/<模块>/` 内部通常遵循五段式约定 —
> `types/`、`constants/`、`hooks/`、`utils/`、`view/`，索引文件不再逐一展开。

## 开发命令

```bash
# 安装依赖
npm install

# 开发模式 (前后端同时启动)
npm run dev

# 仅启动后端
npm run server:dev

# 仅启动前端
npm run client

# 生产构建
npm run build

# 类型检查
npm run typecheck

# 代码检查
npm run lint
npm run lint:fix
```

## 代码风格与约定

### 提交信息规范
使用 [Conventional Commits](https://conventionalcommits.org/) 格式：

```
<type>(<scope>): <description>

# 示例
feat: add conversation search
fix(editor): syntax highlighting for .env files
refactor(chat): extract message list component
```

**类型列表**:
- `feat`: 新功能
- `fix`: 修复 Bug
- `perf`: 性能优化
- `refactor`: 代码重构
- `docs`: 文档更新
- `style`: 样式修改
- `chore`: 维护任务

### TypeScript 配置
- 前端使用 `tsconfig.json`，路径别名 `@/*` 映射到 `src/*`
- 后端使用 `server/tsconfig.json`，有独立的路径映射
- 启用严格模式 (`strict: true`)

### 组件结构
组件按功能模块组织在 `src/components/` 下，每个模块通常包含：
- `types/` - 类型定义
- `constants/` - 常量
- `hooks/` - 自定义 Hooks
- `utils/` - 工具函数
- `view/` - 视图组件

## AI 协作建议

### 代码修改时请注意
1. **保持一致性**: 遵循现有的代码风格和命名约定
2. **TypeScript 优先**: 新代码应使用 TypeScript
3. **组件拆分**: 保持组件职责单一，遵循现有的模块化结构
4. **国际化**: UI 文本应使用 i18next 进行国际化处理

### 测试修改
- 修改后请运行 `npm run typecheck` 确保类型正确
- 运行 `npm run lint` 检查代码规范
- 运行 `npm run build` 确保构建成功

### 关键文件定位
- **添加新路由**: `server/routes/`
- **添加新组件**: `src/components/`
- **修改 API**: `server/routes/` 对应的文件
- **添加翻译**: `src/i18n/locales/`
- **模型配置**: `shared/modelConstants.js`

## 重要注意事项

1. **安全性**: 所有 Claude Code 工具默认禁用，需要用户手动启用
2. **许可证**: AGPL-3.0-or-later，修改后作为网络服务运行需公开源码
3. **兼容性**: 需要 Node.js 22+ 版本
4. **数据同步**: UI 的配置与 `~/.claude` 目录同步

## 相关资源

- **文档**: https://cloudcli.ai/docs
- **GitHub**: https://github.com/siteboon/claudecodeui
- **Discord**: https://discord.gg/buxwujPNRE
- **问题反馈**: https://github.com/siteboon/claudecodeui/issues
