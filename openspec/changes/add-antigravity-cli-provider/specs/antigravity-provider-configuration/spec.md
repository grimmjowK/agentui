## ADDED Requirements

### Requirement: 安装与认证状态
系统 SHALL 为 Antigravity 独立提供安装状态与认证检测，向用户呈现准确的 CLI 可用性。

#### Scenario: 未安装或未登录
- **WHEN** 未在 PATH 或常见目录找到 `agy`，或 CLI 未完成认证
- **THEN** 系统 SHALL 分别显示未安装或未登录状态，并提供官方安装与登录指引链接

#### Scenario: 旧登录入口停用指引
- **WHEN** Gemini 返回个人账号停用的错误
- **THEN** 系统 SHALL 展示 Antigravity 设置入口或新建 Antigravity 会话的引导

### Requirement: Agent 选择与开关
系统 SHALL 在现有设置、模型选择器中支持 Antigravity，并遵守全局 Agent 启停配置。

#### Scenario: 模型列表展示
- **WHEN** 用户在聊天界面选择 Antigravity
- **THEN** 系统 SHALL 提供经核验的 Antigravity 模型列表供用户选择，并持久化当前选中的 Provider

#### Scenario: 启停开关控制
- **WHEN** 用户在设置中关闭 Antigravity Agent
- **THEN** 新建会话选择器 SHALL 隐藏该 Provider，已有历史会话仍可正常查看

### Requirement: 复用基类管理 MCP 配置
系统 SHALL 继承 `McpProvider`，支持在指定作用域（如 user、project）读写 Antigravity 的 MCP 配置文件。

#### Scenario: 修改 MCP 服务
- **WHEN** 用户在设置界面添加或修改 MCP 服务器
- **THEN** 系统 SHALL 原子写入对应作用域的配置文件，保留无关字段，格式损坏时拒绝覆盖

### Requirement: 复用基类扫描 Skills
系统 SHALL 继承 `SkillsProvider`，自动扫描工作区及用户目录下的技能定义（`SKILL.md`）。

#### Scenario: 技能发现与去重
- **WHEN** 系统加载技能列表
- **THEN** 系统 SHALL 从配置的根目录（如 `.agents/skills`）扫描并去重，生成统一的技能指令格式（如 `/skill-name`）
