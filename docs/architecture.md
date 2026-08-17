# 架构设计

## 总览

插件遵循 DSH「一切皆插件」的 Host 面 / Client 面分离（NF-01）：

```
┌──────────────────────────────────────────────────────────────────┐
│                      DSH 宿主进程                                │
├──────────────────────────────────────────────────────────────────┤
│  Host 面 (host plane)                                           │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────────┐   │
│  │ KanbanStore    │ │ GitService     │ │ SchedulerService   │   │
│  │ (storage       │ │ (worktree/     │ │ (dispatch/queue/   │   │
│  │  domain)       │ │  diff/merge)   │ │  heartbeat/timers) │   │
│  └────────────────┘ └────────────────┘ └────────────────────┘   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ RPC: POST /herness-kanban/rpc  + SSE /herness-kanban/events│  │
│  └────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│  Client 面 (client plane)                                       │
│  ┌──────────────┐ ┌────────────────┐ ┌─────────────────────┐    │
│  │ 📋 看板 tab  │ │ 19 个 agent 工具│ │ herness-kanban skill│    │
│  │ (React 槽位) │ │ (herness_      │ │ (ctx.skills)        │    │
│  │              │ │  kanban_*)     │ │                     │    │
│  └──────────────┘ └────────────────┘ └─────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

## 模块划分（源码）

| 模块 | 职责 | 对应需求 |
|------|------|----------|
| `src/types.ts` | 数据模型（Board/Task/Attempt/Comment/Event/Diff） | §6 |
| `src/domain.ts` | DSH storage domain（zod 记录 schema） | DS-05 |
| `src/store.ts` | 读写的唯一入口：CRUD、事件、评论、描述版本、attempt、250ms 防抖落盘 | TM-01..TM-10, NF-09 |
| `src/git.ts` | Git worktree 创建/销毁、diff、`--no-ff` 合并、revert、冲突检测 | AE-02, CR-01..CR-07 |
| `src/scheduler.ts` | 派发/排队/并发上限、心跳看门狗、定时器 | AE-01..AE-08, TA-01..TA-04, NF-06, NF-10 |
| `src/runner.ts` | DshAgentRunner：`ctx.agents.create` 绑定 worktree 的 Session | DS-06 |
| `src/service.ts` | 业务门面：工具与 RPC 共享同一套不变量 | — |
| `src/tools/` | 19 个 `herness_kanban_*` 工具 | DS-01 |
| `src/skill.ts` | `herness-kanban` skill | DS-02 |
| `src/rpc.ts` | HTTP RPC + SSE | DS-04 |
| `client/src/` | 看板 UI（4 列、拖拽、抽屉、Diff 审查、Toast） | DS-03, KB-*, CR-* |

## 执行隔离（核心差异化）

```
主仓库: /path/to/repo (main 分支，永不直接写入)
    │
    ├─ git worktree add /path/to/repo-task-001 herness-task-001
    │    └─ 任务 A 的 Agent Session（cwd = 该 worktree）
    ├─ git worktree add /path/to/repo-task-002 herness-task-002
    │    └─ 任务 B 的 Agent Session
    └─ ...
```

- 每个任务一个 worktree + 一个分支，文件系统与主仓库完全隔离（NF-07, NF-16）。
- 派发前自动 fetch + 主分支快进同步（CR-07）。
- 合并/回滚/删除任务时销毁 worktree，避免孤立状态。

## 状态机

```
todo ──dispatch──▶ doing ──settle success──▶ review ──merge──▶ done
  ▲                   │                          │
  │                   └── settle failed ─────────┤
  └─── reject（驳回，保留代码）/ revert（回滚，撤销合并）────┘
```

状态流转由 KanbanStore.settleAttempt / mergeTask / rejectTask / revertTask
统一驱动，每次流转写入事件时间线（TM-07），触发 SSE 通知（NF-12, NF-13）。

## 数据流（UI ↔ 宿主）

```
浏览器                                宿主
  │  GET /herness-kanban/events (SSE) ──▶ publish({type})
  │  ◀── data: {"type":"board_changed"} ──┐ domain/changed（250ms 防抖）
  │  POST /herness-kanban/rpc ──────────▶ dispatchRpc(handlers) ──▶ KanbanService
  │  ◀────────────── {ok, value} ────────┘        │
  │                                                ├─▶ KanbanStore（storage domain）
  │                                                ├─▶ GitService（child_process git）
  │                                                └─▶ SchedulerService（ctx.agents）
```

领域写入经过 DSH storage 的原子写链；domain/changed 事件驱动 SSE 推送，
客户端收到后重新拉取快照 —— 无需轮询。

## 资源清理（NF-04）

- 领域句柄：ctx.effect 中 domain.close()。
- 工具注册：ctx.tools.register 返回的 disposer 全部收集、逆序执行。
- 定时器：scheduler.dispose() 清空 queue、清除 interval 定时器。
- Agent Session：handle.dispose() / agent.cancel()。
- SSE 连接：浏览器端 source.close()，服务端在响应关闭时移除。

