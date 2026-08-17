# deepseek-herness-kanban 文档

Vibe Kanban for DeepSeek Harness：4 列工作流 + Git Worktree 隔离执行 + 强制代码审查 + 对话上下文沉淀。

## 文档目录

- [快速开始](./quickstart.md) — 安装、导入仓库、创建第一张卡片
- [架构设计](./architecture.md) — Host/Client 分离、执行隔离、数据流
- [配置说明](./configuration.md) — 所有配置项与 bundle patch
- [Agent 工具](./tools.md) — 19 个 `herness_kanban_*` 工具的参数与行为
- [RPC 接口](./rpc.md) — `POST /herness-kanban/rpc` 与 SSE 事件
- [开发路线图](./roadmap.md) — 与需求文档 §10 的对照

## 一分钟速览

```
📋 待办 ──派发──▶ ▶️ 进行中 ──成功──▶ 👀 审查中 ──通过──▶ ✅ 已完成
                    │  ▲                    │
                   失败             驳回（保留代码）/ 回滚
                    └──────────────────────┴──▶ 📋 待办 + 摘要
```

每张卡片在独立的 Git worktree（分支 `herness-task-<id>`）中执行；执行结束
进入审查列，人工逐行审查 Diff 后一键合并；驳回可选「驳回到待办」（保留
代码，补充内容后重新派发）或「回滚」（撤销合并）。AI 写的每一行代码都必须
经过人工 Review 才能进入主分支。

