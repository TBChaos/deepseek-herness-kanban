# 开发路线图

与需求文档 §10 的对照。当前仓库已实现 P0 主线（M1、M2、M4、M5 的核心）。

## 已实现

- [x] 阶段一 基础框架：Host/Client 分离、数据模型、storage domain、4 列看板 UI、拖拽换列、任务 CRUD UI
- [x] 阶段二 任务管理：详情抽屉、评论线程、事件时间线、执行历史、会话绑定（TM-09）、描述版本沉淀（TM-10）、优先级/负责人/徽章、搜索过滤
- [x] 阶段四 Git Worktree 执行引擎：worktree 创建/销毁、`herness-task-<id>` 分支、Session 绑定、并行调度（默认 5 并发 + 队列）、心跳监控（日志+进度文件）、超时终止、实时进度（SSE + 快照）
- [x] 阶段五 代码审查：文件级 Diff、一键合并（`--no-ff`）、驳回（保留代码，`reject_task`）/ 一键回滚（`revert_task`）、冲突检测、审查评论（评论可锚定文件/行）
- [x] 阶段六 DSH 原生集成：19 个工具、`herness-kanban` skill、RPC `POST /herness-kanban/rpc`、Toast 通知
- [x] 阶段七 对话拆解：`parse_conversation` 完整流程（DC-01..DC-04）
- [x] 工作流状态机（Req 2）：仅待办可派发；review 三个出口（merge→done / reject→todo 保留代码 / revert→todo 回滚）；手动换列受限
- [x] 工作区归属（Req 1）：派发会话与任务细化会话注册到 workspace registry，不再显示为“未分组”
- [x] 任务细化对话（Req 3）：`discuss_task` 为待办卡片开启专属会话，上下文仅含该卡片内容
- [x] 卡片直接补充细节：看板 UI「✏️ 补充细节」/ 驳回面板追加新要求（`tasks.appendDetail`），无需回到会话

## 部分实现 / 待完善

- [ ] 定时自动化（TA-01..TA-04）：interval/daily/父任务激活已实现；UI 编辑定时器尚未接入
- [ ] 列折叠与状态记忆（KB-04）
- [ ] 批量操作（KB-06）：Ctrl/Cmd 多选
- [ ] 编辑器/终端快捷打开（DI-01, DI-02）
- [ ] Diff 视图逐行评论的 UI 交互（CR-05：数据层已支持，UI 双击尚未接评论框）
- [ ] 合并冲突解决指引 UI（CR-06：检测已实现）
- [ ] Windows 平台 Git worktree 的完整回归（风险表第一条）

## 技术债 / 后续

- 为 `parse_conversation` 增加一次 LLM 去重/质量校验（DC-03 阈值可调）。
- 看板 UI 换用 `dsh-client-ui-primitives` 组件，风格与 DSH 其余面板一致。
- 补充 e2e：真实 DSH profile 中加载插件、跑通一次 dispatch → review → merge。
- 打包 CI：`pnpm pack` 产出 tarball 验证 `dsh plugin add`。

