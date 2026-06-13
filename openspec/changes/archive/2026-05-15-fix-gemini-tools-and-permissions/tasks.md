## 1. 后端：修复 Gemini CLI 启动参数

- [x] 1.1 修改 `server/gemini-cli.js` 中的 `spawnGemini()` 函数，移除 `--allowed-tools` 参数传递逻辑（约第 281-283 行）
- [x] 1.2 修改权限模式映射逻辑（约第 270-279 行），使所有权限模式均传入 `--yolo` 参数，替代原有的 `--approval-mode` 分支
- [x] 1.3 在 `GeminiPermissionDetector` 类上添加 `@deprecated` 注释，说明 headless + stream-json 模式下 TUI 权限检测不可用

## 2. 前端：添加 Gemini 工具名映射

- [x] 2.1 在 `src/components/chat/tools/configs/toolConfigs.ts` 中为 Gemini CLI 工具名添加别名条目（`run_shell_command` → 复用 `Bash` 配置，`read_file` → 复用 `Read` 配置，`write_file` → 复用 `Write` 配置，`replace` → 复用 `Edit` 配置，`grep_search` → 复用 `Grep` 配置，`glob` 保持原有配置，`write_todos` → 复用 `TodoWrite` 配置，`invoke_agent` → 复用 `Task` 配置）
- [x] 2.2 在 `getToolCategory()` 函数中添加 Gemini 工具名的分类映射

## 3. 前端：权限模式 UI 提示

- [x] 3.1 在权限模式设置相关组件中，当 provider 为 Gemini 时显示提示信息："Gemini CLI 在非交互模式下工具将自动执行，权限模式设置不影响实际执行行为"

## 4. 验证

- [x] 4.1 运行 `npm run typecheck` 确保类型检查通过
- [x] 4.2 运行 `npm run lint` 确保代码规范通过
- [x] 4.3 手动测试：使用 Gemini 模型发送包含 shell 命令的请求，确认 `run_shell_command` 不再报 "Tool not found"
- [x] 4.4 手动测试：确认 Gemini 工具调用在前端正确渲染（终端风格显示 shell 命令、diff 视图显示文件编辑等）
