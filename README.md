# deepseek-herness-kanban

> Vibe Kanban for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
> a 4-column board where AI agents pick up cards, work in **isolated Git worktrees**,
> and every line they write passes a **forced human code review** before merging.
> Cards accumulate the whole conversation context of a feature, and a single tool
> turns any chat into a batch of tasks.

[![npm](https://img.shields.io/npm/v/deepseek-herness-kanban)](https://www.npmjs.com/package/deepseek-herness-kanban)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[中文文档](./README.zh.md) · [Docs](./docs/README.md) · [MIT](./LICENSE)

## Highlights

- **Git worktree isolation** — every card runs in its own worktree on its own
  branch; agents can do anything without ever touching the main branch.
- **Forced code review** — finished runs land in a review column; read the
  per-file diff and one-click merge or revert. No AI change reaches `main`
  without human approval.
- **Cards accumulate context** — comments, requirement changes (with version
  history), execution attempts, and an event timeline stay on the card, which
  stays linked to the originating conversation.
- **Conversation → tasks** — one tool call turns a discussion into a batch of
  de-duplicated, dependency-linked task cards.
- **Multi-agent parallel runs** — up to 5 tasks execute concurrently by default,
  with extra dispatches queued automatically.
- **Minimal 4-column workflow** — todo → doing → review → done; complex states
  are badges: ⏰ scheduled, 🚫 blocked, 🔴 running, 👀 reviewing.
- **Heartbeat monitoring** — dual signal (logs + progress file) with a
  configurable 30-minute timeout.

## The workflow

```
📋 todo ──dispatch──▶ ▶️ doing ──success──▶ 👀 review ──approve──▶ ✅ done
                        │  ▲                    │
                      failed                   reject + revert
                        └──────────────────────┴──▶ 📋 todo + summary
```

1. **Import a repo** — the plugin detects the Git repository, or runs `git init`.
2. **Create cards** — manually, or ask the agent to “turn this conversation into tasks”
   (`herness_kanban_parse_conversation`).
3. **Dispatch** — each card runs in its own worktree (`<repo>-<task-id>`) on branch
   `herness-task-<id>`; up to 5 cards run in parallel by default.
4. **Review** — read the per-file diff, then one-click **merge** or **revert**.
   No AI change ever reaches `main` without human approval.
5. **Context** — comments, description versions, attempts, and events stay on the card forever.

## Install

```sh
# from the npm registry
dsh plugin --profile web add deepseek-herness-kanban

# from a local checkout / tarball
dsh plugin --profile web add link:/path/to/deepseek-herness-kanban
dsh plugin --profile web add ./deepseek-herness-kanban-<version>.tgz
```

Then open the DSH Web GUI → click **📋 看板** in the sidebar.

Requirements: Node ≥ 22.19, Git ≥ 2.25, pnpm.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run build          # host lib/ + client bundle
pnpm test               # unit tests (node --test)
```

Load a development checkout into a profile without publishing:

```sh
dsh plugin --profile dev add link:/path/to/deepseek-herness-kanban
dsh web --profile dev
```

The bundle layer is declared in [cordis.patch.yml](./cordis.patch.yml); every
config key is documented there and in [docs/configuration.md](./docs/configuration.md).

## Architecture at a glance

```
┌─ DSH host process ────────────────────────────────────────────┐
│  Host plane            │  Client plane                        │
│  • KanbanStore         │  • 19 herness_kanban_* agent tools   │
│    (storage domain)    │  • herness-kanban skill              │
│  • GitService          │  • 📋 看板 tab (React, slot system)  │
│  • SchedulerService    │  • POST /herness-kanban/rpc          │
└────────────────────────┴──────────────────────────────────────┘
```

Read the full story in [docs/architecture.md](./docs/architecture.md).

## The 19 agent tools

Boards: `list_boards`, `create_board`, `delete_board` · Tasks:
`list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task`,
`move_task`, `add_comment`, `update_description`, `discuss_task` ·
Execution: `dispatch_task`, `stop_task`, `merge_task`, `get_diff`,
`reject_task`, `revert_task` · Decomposition: `parse_conversation` — all
prefixed `herness_kanban_`, see [docs/tools.md](./docs/tools.md).

## License

MIT

