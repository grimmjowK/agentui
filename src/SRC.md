# src — 前端结构索引

React 18 + TypeScript 前端。组件按功能模块组织在 `components/`，
详见 [components/COMPONENTS.md](./components/COMPONENTS.md)。其余顶层目录如下。

## 顶层目录

| 目录 | 职责 |
| --- | --- |
| `components/` | UI 组件，按功能模块组织，见 [components/COMPONENTS.md](./components/COMPONENTS.md) |
| `contexts/` | React 全局状态容器：WebSocket、Plugins、PaletteOps、Permission、TaskMaster |
| `hooks/` | 自定义业务 Hooks：项目/会话状态、Web Push、版本检测、设备偏好、会话保护等 |
| `stores/` | Zustand 状态存储；`useSessionStore` 按 sessionId 管理消息（后端 JSONL 为真实源） |
| `utils/` | 前端工具函数：剪贴板操作、日期格式化 |
| `lib/` | 样式工具库：`cn()` 合并 Tailwind 类、`safeJsonParse()` 安全解析 JSON |
| `shared/` | 通用 UI 组件库（Card/Button/Dialog/Input 等）与基础类型（含 `view/`） |
| `constants/` | 应用配置常量：`IS_PLATFORM` 平台标志等 |
| `types/` | TypeScript 类型定义：`app.ts` 核心类型、`sharedTypes.ts`、全局与第三方声明 |
| `i18n/` | i18next 国际化配置，支持 en/zh-CN/ja/ko/ru/de/tr/it 共 8 种语言 |
