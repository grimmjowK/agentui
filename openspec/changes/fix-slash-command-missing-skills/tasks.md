## 1. 后端：合并 Skills 到命令列表

- [x] 1.1 在 `server/routes/commands.js` 中 import `providerSkillsService`
- [x] 1.2 修改 `POST /api/commands/list` 端点，从请求体读取可选的 `provider` 参数（默认 `'claude'`）
- [x] 1.3 调用 `providerSkillsService.listSkills(provider, projectPath)` 获取 skills 列表，不支持的 provider 用 try-catch 降级为空数组
- [x] 1.4 将 skills 转换为 SlashCommand 格式（`name` 加 `/` 前缀，`namespace: 'skill'`，`description` 取自 frontmatter），合并到返回结果中，新增 `skills` 字段

## 2. 前端 Hook：传递 provider 并合并 Skills

- [x] 2.1 `useSlashCommands` 的 `UseSlashCommandsOptions` 接口新增 `provider?: string` 属性
- [x] 2.2 `fetchCommands` 请求体新增 `provider` 字段
- [x] 2.3 合并响应中的 `data.skills`（如果存在）到 `allCommands`，`type` 设为 `'skill'`
- [x] 2.4 将 `provider` 加入 `useEffect` 依赖数组，确保 provider 切换时重新加载

## 3. 前端组件：CommandMenu 新增 Skill 分组

- [x] 3.1 在 `CommandMenu.tsx` 的 `namespaceLabels` 新增 `skill: 'Skills'`
- [x] 3.2 在 `namespaceIcons` 新增 `skill: '[S]'`
- [x] 3.3 在 `preferredOrder` 数组中 `user` 之后加入 `'skill'`

## 4. 状态传递：向 Hook 传递 provider

- [x] 4.1 在 `useChatComposerState.ts` 中将 `selectedProvider` 透传给 `useSlashCommands` 调用

## 5. 验证

- [x] 5.1 运行 `npm run typecheck` 确保类型检查通过
- [x] 5.2 运行 `npm run build` 确保构建成功
- [ ] 5.3 启动 `npm run dev`，在聊天输入框输入 `/`，确认 Skills 分组出现并包含已安装的 skills
