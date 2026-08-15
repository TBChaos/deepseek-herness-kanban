# deepseek-herness-kanban

> DeepSeek Harness 的 Vibe Kanban：4 列看板 + Git Worktree 隔离执行 + 强制代码审查 + 对话上下文沉淀。

[English](./README.md) · [文档](./docs/README.md) · [MIT](./LICENSE)

## 核心能力

- **Git Worktree 隔离执行**：每张卡片在独立 worktree + 独立分支中运行，
  Agent 随便折腾，主分支永远安全。
- **强制代码审查**：执行结束自动进入审查列，逐行 Diff 审阅后一键合并或
  回滚——AI 的每一行改动都必须人工批准才能进入主分支。
- **对话上下文沉淀**：卡片是信息中心，评论、需求变更版本、执行记录、
  事件时间线全程累积，并绑定来源会话，随时回溯。
- **对话 → 任务自动拆解**：对 AI 说「把刚才讨论的拆解成任务」，一次生成
  多张卡片，自动去重、自动建立依赖。
- **多代理并行**：默认 5 个任务同时执行，超出自动排队，互不阻塞。
- **极简 4 列工作流**：待办 → 进行中 → 审查中 → 已完成，复杂状态用
  ⏰ 定时 / 🚫 阻塞 / 🔴 运行中 等徽章表达。
- **心跳监控**：日志 + 进度文件双重信号，30 分钟无信号自动终止（可配置）。

## 工作流

```
📋 待办 ──派发──▶ ▶️ 进行中 ──成功──▶ 👀 审查中 ──通过──▶ ✅ 已完成
                    │  ▲                    │
                   失败                   驳回 + 回滚
                    └──────────────────────┴──▶ 📋 待办 + 摘要
```

1. **导入仓库**：自动识别 Git 仓库，不存在则 `git init`。
2. **创建卡片**：手动创建，或对 AI 说“把刚才讨论的拆解成看板任务”。
3. **派发执行**：每张卡片在独立 worktree（分支 `herness-task-<id>`）中由
   DSH Agent 执行，默认 5 个并行。
4. **代码审查**：逐行 Diff，一键合并或回滚——AI 的任何改动都必须人工批准
   才能进入主分支。
5. **上下文沉淀**：评论、描述版本、执行记录、事件时间线永远留在卡片上。

## 安装

```sh
# npm（发布后）
dsh plugin --profile web add deepseek-herness-kanban

# 本地 / tarball
dsh plugin --profile web add link:/path/to/deepseek-herness-kanban
dsh plugin --profile web add ./deepseek-herness-kanban-0.1.0.tgz
```

然后打开 Web GUI，点击侧边栏 **📋 看板**。

要求：Node ≥ 22.19、Git ≥ 2.25、pnpm。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run build          # 产出 lib/（宿主）+ client/index.js（前端）
pnpm test               # node --test 单元/集成测试
```

本地联调：

```sh
dsh plugin --profile dev add link:/path/to/deepseek-herness-kanban
dsh web --profile dev
```

## 17 个 Agent 工具

看板：`list_boards` / `create_board` / `delete_board`；任务：`list_tasks` /
`get_task` / `create_task` / `update_task` / `delete_task` / `move_task` /
`add_comment` / `update_description`；执行：`dispatch_task` / `stop_task` /
`get_diff` / `merge_task` / `revert_task`；拆解：`parse_conversation` ——
前缀均为 `herness_kanban_`，详见 [docs/tools.md](./docs/tools.md)。

## License

MIT

