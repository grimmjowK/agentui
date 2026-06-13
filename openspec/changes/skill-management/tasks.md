## 1. 后端 API - Skills CRUD

- [x] 1.1 创建 `server/routes/skills.js`，实现 `GET /api/providers/:provider/skills` 列出全局和项目级 skills（provider 映射：claude→.claude, gemini→.gemini）
- [x] 1.2 实现 `POST /api/providers/:provider/skills` 创建/更新 skill（含名称 kebab-case 规范化和路径分隔符校验）
- [x] 1.3 实现 `DELETE /api/providers/:provider/skills/:name` 删除指定 scope 下的 skill 文件
- [x] 1.4 实现 `POST /api/providers/:provider/skills/upload` 文件上传（支持 .md 和 .zip，含路径遍历防护）
- [x] 1.5 在 `server/index.js` 挂载 skills 路由到 `/api/providers/:provider/skills`，仅允许 claude 和 gemini

## 2. 前端 Hook 和类型

- [x] 2.1 新增 Skill 相关 TypeScript 类型定义（SkillItem, SkillScope 等）
- [x] 2.2 新增 `useSkills` Hook，封装 skills API 调用（列表、创建、更新、删除、上传），接收 provider 参数

## 3. 前端 UI - Skills 标签页

- [x] 3.1 在 AgentCategoryTabsSection 新增 "Skills" 标签（与 Account、Permissions、MCP 并列）
- [x] 3.2 在 AgentCategoryContentSection 新增 Skills 内容渲染分支（Claude/Gemini 显示内容，Cursor/Codex 显示不支持提示）
- [x] 3.3 实现 SkillsContent 组件：Skill 列表按 scope 分组展示（User / Project），含空状态提示

## 4. 前端 UI - Skill 编辑与上传

- [x] 4.1 实现 SkillEditorModal 组件：创建/编辑 Modal，含名称输入、scope 选择、Markdown 编辑器
- [x] 4.2 实现编辑模式：点击 skill 条目打开 Modal，预填 name（只读）、scope（只读）、content
- [x] 4.3 实现 SkillUploadModal 组件：文件上传 Modal，支持 .md 和 .zip 文件选择与 scope 选择
- [x] 4.4 实现文件类型校验（仅允许 .md 和 .zip）和上传成功后列表刷新

## 5. 国际化与集成

- [x] 5.1 添加 Skills 相关 i18n 翻译键（en/zh-CN settings 命名空间）
- [x] 5.2 类型检查和代码检查通过（typecheck + lint）
- [ ] 5.3 端到端手动测试：创建、编辑、删除、上传 skill 全流程验证
