import { randomBytes } from 'node:crypto'

/**
 * Compact, sortable, collision-resistant identifiers. The 16-hex payload keeps
 * ids short enough to read on cards while staying unique across restarts.
 */
export function makeId(prefix: string, now = Date.now()): string {
  return prefix + '-' + now.toString(36) + '-' + randomBytes(4).toString('hex')
}

export function taskId(): string {
  return makeId('task')
}

export function boardId(): string {
  return makeId('board')
}

export function attemptId(): string {
  return makeId('attempt')
}

export function eventId(): string {
  return makeId('event')
}

export function commentId(): string {
  return makeId('comment')
}

/** Branch name for a task's isolated work, e.g. herness-task-<id>. */
export function branchNameFor(task: { id: string }): string {
  return 'herness-task-' + task.id
}

/** Worktree directory name: <repo>-<taskId> next to the main repository. */
export function worktreePathFor(board: { repoPath: string }, task: { id: string }): string {
  return board.repoPath + '-' + task.id
}

export function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19)
}

export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}
