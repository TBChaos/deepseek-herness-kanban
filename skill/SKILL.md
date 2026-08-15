---
name: herness-kanban
description: Operate the deepseek-herness-kanban board: create and update cards, dispatch work into isolated Git worktrees, review diffs, merge or revert, and decompose the current conversation into tasks. Load this skill when the user asks about the kanban board, task cards, dispatching work, code review of an agent's changes, or turning a discussion into tasks.
---

# herness-kanban

You have access to 17 tools prefixed `herness_kanban_`. Use them to manage
the user's Vibe Kanban board for DeepSeek Harness.

## The workflow (4 columns)

1. **待办 todo** — cards waiting to be worked.
2. **进行中 doing** — an agent is executing the card in an isolated Git
   worktree (branch `herness-task-<id>`).
3. **审查中 review** — execution finished; a human must review the diff
   before anything merges.
4. **已完成 done** — merged into the main branch.

## When the user asks you to do work

- The user may point at a card: "do task X" — call
  `herness_kanban_dispatch_task` with its id, then continue helping in THIS
  session only if asked; otherwise tell the user the task is running and they
  can watch the board.
- When a task you dispatched fails, read `herness_kanban_get_task` for the
  error summary and `herness_kanban_add_comment` to record what went wrong.

## Cards are context containers

Every card accumulates context for its whole lifetime:

- **Requirements change?** Use `herness_kanban_update_description` (old
  versions are kept as events).
- **Discussion?** Use `herness_kanban_add_comment`.
- Cards remember the session/thread that created them, so the conversation
  that produced a task can always be traced back.

## Turning a conversation into tasks

When the user says something like "把刚才讨论的拆解成看板任务" /
"turn what we discussed into kanban tasks", call
`herness_kanban_parse_conversation`. It analyzes the recent conversation,
extracts actionable tasks, de-duplicates against existing cards, and creates
them on the board — all bound to this session.

## Review and merge

- `herness_kanban_get_diff` shows exactly what the agent changed
  (base = main branch, head = the task branch).
- When the user approves: `herness_kanban_merge_task`.
- When the user rejects: `herness_kanban_revert_task` rolls back and
  returns the card to 待办 with review notes.

## Golden rules

- Never merge without explicit human approval — every AI change is reviewed.
- Dispatch blocks the card while running; do not dispatch a card that is
  already running or queued.
- Report failures on the card (`add_comment`), not only in chat.
- Prefer small, self-contained cards; a failed card returns to 待办 with the
  error summary attached.
