## ADDED Requirements

### Requirement: build-in 指令结果在 chat 内联渲染
提交 build-in 指令后，系统 **SHALL** 将结果在 chat 消息流内联渲染；对需要选择/交互的指令 **SHALL** 渲染为结构化可交互 UI，而非纯文本。

#### Scenario: /model 渲染为可选择模型列表
- **WHEN** 用户提交 `/model` 指令（无指定模型参数）
- **THEN** chat 内联渲染一个可点击的模型列表
- **AND** 列表项来自当前 provider 的可用模型
- **AND** 当前生效的模型以视觉方式标识

#### Scenario: 点击模型项切换模型
- **WHEN** 用户点击模型列表中的某一项
- **THEN** 系统切换到该模型
- **AND** 列表标识更新为已选中该模型

#### Scenario: 带参数的 /model 直接切换
- **WHEN** 用户提交带模型名参数的 `/model`（如通过追加文本指定）
- **THEN** 系统直接切换到该模型，无需再展示列表

### Requirement: 纯展示类 build-in 指令保留可读文本渲染
对不需要交互选择的 build-in 指令（如 `/cost`、`/status`、`/help`），系统 **SHALL** 在 chat 内联渲染其结果文本。

#### Scenario: /cost 内联展示用量
- **WHEN** 用户提交 `/cost` 指令
- **THEN** chat 内联展示 token 用量与成本信息
- **AND** 不发生标签页切换
