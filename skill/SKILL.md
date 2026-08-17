---
name: herness-kanban
description: Operate the deepseek-herness-kanban board: create and update cards, refine a task's requirements in a task-scoped conversation, dispatch work into isolated Git worktrees, review diffs, merge or revert, and decompose the current conversation into tasks. Load this skill when the user asks about the kanban board, task cards, dispatching work, code review of an agent's changes, or turning a discussion into tasks.
---

# herness-kanban

You have access to 19 tools prefixed `herness_kanban_`. Use them to manage
the user's Vibe Kanban board for DeepSeek Harness.

## The workflow (4 columns)

1. **待办 todo** — cards waiting to be worked. Only cards here can be
   **dispatched** (`herness_kanban_dispatch_task`) or refined in a dedicated
   conversation (`herness_kanban_discuss_task`).
2. **进行中 doing** — an agent is executing the card in an isolated Git
   worktree (branch `herness-task-<id>`). Entered only via dispatch.
3. **审查中 review** — execution finished; a human must review the diff.
   Review has three exits: **已完成 done** (approved → `merge_task`),
   **待办 todo** with code kept (rejected → `reject_task`), and **待办 todo**
   with the merge undone (→ `revert_task`).
4. **已完成 done** — merged into the main branch.

The column workflow is a state machine: manual moves are limited to
todo→done and done→todo (plus doing→todo to abandon). All other transitions
go through their own entry points (dispatch / settle / merge / reject /
revert).

## When the user asks you to do work

- The user may point at a card: "do task X" — call
  `herness_kanban_dispatch_task` with its id, then continue helping in THIS
  session only if asked; otherwise tell the user the task is running and they
  can watch the board.
- A card must be in **待办 todo** to be dispatched. If it is in review, the
  user must approve (`merge_task`), reject (`reject_task`, merge stays) or
  roll back (`revert_task`, merge undone) it first; a rejected card returns
  to todo for modification.
- When a task you dispatched fails, read `herness_kanban_get_task` for the
  error summary and `herness_kanban_add_comment` to record what went wrong.

## Refining a task before dispatching (Req 3)

- When the user wants to sharpen a todo card's requirements, call
  `herness_kanban_discuss_task` (or use the 💬 细化需求 button in the board
  UI). It spawns a dedicated DSH session whose context contains **only that
  card** (description, comments, events, attempts) — no other board content.
- For small additions the user can also type them straight onto the card in
  the board UI (✏️ 补充细节 button → `tasks.appendDetail`), no session needed.
- The user continues a discussion in that session (listed under the
  project workspace in the GUI sidebar). The agent there writes agreed
  changes back onto the card via `herness_kanban_update_description` and
  `herness_kanban_add_comment`, so the card accumulates the refined
  requirements before dispatch.

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
- When the user approves: `herness_kanban_merge_task` (review → done).
- When the user rejects but the code should stay on main (they plan to keep
  adding requirements and re-dispatch): `herness_kanban_reject_task`
  (review → todo, merge untouched).
- When the merged changes must be undone: `herness_kanban_revert_task`
  reverts the merge on main and returns the card to 待办 with review notes.
- Never move a review card with `herness_kanban_move_task`.

## Golden rules

- Never merge without explicit human approval — every AI change is reviewed.
- Only dispatch cards in 待办 todo; never dispatch a card that is already
  running or queued.
- Report failures on the card (`add_comment`), not only in chat.
- Prefer small, self-contained cards; a failed card returns to 待办 with the
  error summary attached.
