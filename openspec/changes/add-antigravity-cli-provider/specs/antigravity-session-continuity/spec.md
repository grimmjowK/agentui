## ADDED Requirements

### Requirement: 会话身份与原生恢复
系统 SHALL 在 `sessions` 表中记录会话元数据（包含原生 conversation ID 及 transcript 文件路径），且只通过原生 ID 向 CLI 发起会话恢复。

#### Scenario: 重启后多轮续接
- **WHEN** 用户在服务重启或刷新页面后打开已有 Antigravity 会话并发送下一条消息
- **THEN** 系统 SHALL 使用该会话持久化的原生 ID 作为恢复参数调用 `agy`，不使用全局 latest

#### Scenario: 旧版本数据目录中的会话
- **WHEN** Antigravity 会话的轨迹数据库位于旧版应用数据目录，而 `agy` 从 CLI 数据目录加载轨迹
- **THEN** 系统 SHALL 在不修改源文件的前提下将该会话的 SQLite 轨迹快照迁移到 CLI 数据目录，使聊天与终端均可恢复原会话

#### Scenario: 原生会话不可恢复
- **WHEN** 原生 ID 缺失、失效或被 CLI 拒绝恢复
- **THEN** 系统 SHALL 展示无法续接的明确错误并提供新建会话入口，不将新会话伪装为原会话执行

### Requirement: 基于 Transcript 的历史加载与同步
系统 SHALL 遵循现有的 Provider 会话历史契约，由 Sessions Provider 从本地原生 transcript JSONL 文件流式读取消息与分页，并由 Session Synchronizer 扫描同步索引。

#### Scenario: 历史刷新与分页
- **WHEN** 用户刷新页面、重启服务或分页请求 Antigravity 历史
- **THEN** 系统 SHALL 从对应 transcript JSONL 流式解析已保存的消息并按统一格式返回正确分页元数据；`limit: 0` 返回空页，`limit: null` 返回完整历史

#### Scenario: 外部或离线会话同步
- **WHEN** 触发会话同步服务（扫描指定周期内的本地 transcript 文件）
- **THEN** Session Synchronizer SHALL 幂等解析会话标题、时间戳并更新至 `sessionsDb`，不重复插入已存在的记录

### Requirement: Gemini 历史隔离
系统 SHALL 保留原有 Gemini 历史的 provider 标识、会话 ID 和读取方式，不将其自动改写为 Antigravity 会话。

#### Scenario: 查看旧历史
- **WHEN** 用户接入 Antigravity 后打开原有的 Gemini 会话
- **THEN** 系统 SHALL 继续通过原 Gemini 历史适配器读取内容，不尝试用该 ID 恢复 Antigravity 会话

#### Scenario: 从旧会话新建
- **WHEN** 用户选择在同一项目新建 Antigravity 对话
- **THEN** 系统 SHALL 创建独立会话并明确说明旧上下文不会自动继承，原 Gemini 会话保持独立
