# Agent 工具清单（19 个）

全部以 `herness_kanban_` 为前缀，注册进 DSH 工具系统（DS-01）。工具描述与
参数直接面向模型，模型据此调用；卡片上的每项操作都会写入事件时间线。

## 看板（3）

| 工具 | 参数 | 行为 |
|------|------|------|
| `herness_kanban_list_boards` | — | 列出所有看板（id、名称、仓库路径、主分支） |
| `herness_kanban_create_board` | `name`*, `repoPath`*, `description`, `mainBranch` | 导入 Git 仓库；不存在则 `git init`（PM-02） |
| `herness_kanban_delete_board` | `boardId`* | 删除看板及其全部卡片（先停止运行中的任务） |

## 任务（9）

| 工具 | 参数 | 行为 |
|------|------|------|
| `herness_kanban_list_tasks` | `boardId`*, `columnId`, `query` | 按列/全文过滤列卡片 |
| `herness_kanban_get_task` | `taskId`* | 完整上下文：描述、评论、事件、每次 attempt 与日志 |
| `herness_kanban_create_task` | `boardId`*, `title`*, `description`, `priority`, `assignee`, `parentTaskId`, `schedule` | 创建卡片；在 Agent Session 内调用时自动绑定 Session（TM-09） |
| `herness_kanban_update_task` | `taskId`* + 部分字段 | 更新标题/描述/优先级/负责人/定时/阻塞/列；描述旧版本保留（TM-10） |
| `herness_kanban_delete_task` | `taskId`* | 删除卡片（运行中需先停止） |
| `herness_kanban_move_task` | `taskId`*, `columnId`* | 换列；四列工作流是状态机：仅 todo↔done 与 doing→todo 允许手动移动，其余走各自入口（派发/合并/驳回） |
| `herness_kanban_add_comment` | `taskId`*, `content`*, `author`, `filePath`, `lineNumber` | 评论线程；可锚定审查文件的某一行（CR-05） |
| `herness_kanban_update_description` | `taskId`*, `description`* | 需求变更沉淀；旧版本进入时间线 |
| `herness_kanban_discuss_task` | `taskId`* | 为待办任务开启**任务专属细化对话**：新建 DSH 会话，上下文仅包含该卡片（Req 3） |

## 执行（6）

| 工具 | 参数 | 行为 |
|------|------|------|
| `herness_kanban_dispatch_task` | `taskId`* | 创建 worktree + 分支，启动 DSH Agent Session；**仅待办（todo）卡片可派发**（AE-01..AE-04） |
| `herness_kanban_stop_task` | `taskId`* | 取消 Session，卡片回待办（AE-05） |
| `herness_kanban_get_diff` | `taskId`* | 主分支 vs 任务分支的逐文件 diff（CR-01, CR-02） |
| `herness_kanban_merge_task` | `taskId`* | 人工批准后 `--no-ff` 合并、销毁 worktree、卡片入 done；**仅审查中卡片可合并**（CR-03） |
| `herness_kanban_reject_task` | `taskId`*, `reason`* | **驳回到待办（不回滚）**：销毁 worktree、审查意见写评论、卡片回待办，main 上的合并代码保留，可继续补充内容后重新派发（CR-04a） |
| `herness_kanban_revert_task` | `taskId`*, `reason`* | **回滚并驳回**：撤销 main 上的合并提交（已合并时）、销毁 worktree、审查意见写评论、卡片回待办（CR-04） |

## 对话拆解（1）

| 工具 | 参数 | 行为 |
|------|------|------|
| `herness_kanban_parse_conversation` | `boardId`*, `conversation`, `linkDependencies` | 分析对话拆解任务；批量建卡、绑定 Session、去重、依赖成父子关系（DC-01..DC-04） |

`*` = 必填。

## 模型视角的提示

- 未通过人工批准前**永远不要**调用 `merge_task`。
- 只有**待办**卡片可以 `dispatch_task`；审查中的卡片要么 `merge_task`（完成）要么 `reject_task`（驳回，保留代码）或 `revert_task`（回滚），不要用 `move_task` 移动它。
- 待办卡片要细化需求时用 `discuss_task` 开启专属对话，上下文只含该卡片；也可以直接在卡片上补充细节（看板 UI 的「✏️ 补充细节」，服务端 `tasks.appendDetail`）。
- 执行失败时把原因 `add_comment` 到卡片上，而不只是在对话里说。
- 拆解用 `parse_conversation`，任务会自动绑定当前会话。
- 卡片是上下文容器：需求变了用 `update_description`，讨论用 `add_comment`。

## 输出与错误

所有工具返回经过 enforced JSON Schema 校验的规范值，模型看到的是
`output.render` 生成的文本摘要；业务错误以异常抛出（带稳定 code 的
HarnessError 风格），框架会转成 `{ isError: true }` 的结果。

