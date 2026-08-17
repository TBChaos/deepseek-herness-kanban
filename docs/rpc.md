# RPC 接口

Web UI 与宿主之间的桥（DS-04）。两个端点都挂在 DSH Web Server 上，与 Web
GUI 同源：

| 端点 | 方法 | 用途 |
|------|------|------|
| `/herness-kanban/rpc` | `POST` | JSON-RPC 风格的方法调用 |
| `/herness-kanban/rpc` | `GET` | 健康检查，返回可用方法列表 |
| `/herness-kanban/events` | `GET` | SSE 事件流 |

## 请求

```http
POST /herness-kanban/rpc
Content-Type: application/json

{ "method": "state.snapshot", "args": {} }
```

## 响应

成功时：

```json
{ "ok": true, "value": { ... } }
```

失败时：

```json
{ "ok": false, "error": "task not found: xxx" }
```

## 方法列表

### 看板

| 方法 | args | 返回 |
|------|------|------|
| `boards.list` | — | `Board[]` |
| `boards.create` | `{ name, repoPath, description?, mainBranch? }` | `Board` |
| `boards.delete` | `{ boardId }` | `{ ok }` |

### 任务

| 方法 | args | 返回 |
|------|------|------|
| `tasks.list` | `{ boardId? }` | `Task[]` |
| `tasks.get` | `{ taskId }` | `Task` |
| `tasks.create` | `{ boardId, title, description?, priority?, assignee?, parentTaskId?, schedule? }` | `Task` |
| `tasks.update` | `{ taskId, title?, description?, priority?, assignee?, isBlocked?, blockReason?, schedule?, columnId? }` | `Task` |
| `tasks.delete` | `{ taskId }` | `{ ok }` |
| `tasks.move` | `{ taskId, columnId }` | `Task` |
| `tasks.comment` | `{ taskId, content, author?, filePath?, lineNumber? }` | `Comment` |
| `tasks.updateDescription` | `{ taskId, description, author? }` | `Task` |
| `tasks.appendDetail` | `{ taskId, content, author? }` | `Task`（追加带时间戳的「📝 补充」小节到描述，不覆盖原内容） |

### 执行与审查

| 方法 | args | 返回 |
|------|------|------|
| `exec.dispatch` | `{ taskId }` | `{ attemptId, status }` |
| `exec.stop` | `{ taskId }` | `{ ok }` |
| `review.diff` | `{ taskId }` | `DiffSummary` |
| `review.diffstat` | `{ taskId }` | 文本 stat |
| `review.merge` | `{ taskId, author? }` | `{ taskId, commit }` |
| `review.reject` | `{ taskId, reason, author? }` | `{ taskId, commit }`（驳回到待办，不回滚代码） |
| `review.revert` | `{ taskId, reason, author? }` | `{ taskId, commit }`（回滚合并并退回待办） |
| `parse.tasks` | `{ boardId, text?, sessionId?, threadId?, linkDependencies? }` | `{ created, skippedDuplicates, dependencyLinked, taskIds }` |
| `state.snapshot` | — | `{ boards, tasks, running, queue }` |

## SSE 事件

| 事件 | payload | 含义 |
|------|---------|------|
| `board_changed` | — | 领域数据变更（250ms 防抖），客户端应刷新快照 |
| `task_started` | `{ taskId }` | 排队任务开始执行 |
| `task_settled` | `{ taskId, status, title }` | 一次执行结束（成功/失败/停止） |
| `toast` | `{ kind, title, message }` | 桌面通知（NF-13） |

客户端实现参考 `client/src/api.ts`：`fetch` 调用 RPC，`EventSource` 订阅事件；
事件到达后重新拉取 `state.snapshot`，全量快照 + 增量事件保证实时一致。

