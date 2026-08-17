/**
 * Prompts for dispatched agent sessions.
 *
 * The dispatch prompt instructs the agent to work inside its worktree, to
 * write the heartbeat progress file (AE-06), and to report a completion
 * summary. The session inherits the user's DSH model configuration (DS-06).
 */
import type { Board, Task } from './types.js'
import { HEARTBEAT_FILE } from './scheduler.js'

export function dispatchPrompt(task: Task, board: Board, branchName: string, worktreePath: string): string {
  return [
    'You are working on a kanban task. Your session working directory is the',
    'main repository (' + board.repoPath + '), but you MUST do ALL task work',
    'inside your dedicated Git worktree: ' + worktreePath + '.',
    '',
    '## Task',
    '',
    '**Title:** ' + task.title,
    '**Priority:** ' + task.priority,
    '**Board:** ' + board.name,
    '',
    '### Description',
    '',
    task.description || '(no description — infer the goal from the title and the repository)',
    '',
    '## Your workspace',
    '',
    '- Work ONLY inside ' + worktreePath + ' (a dedicated Git worktree for this task).',
    '- Never create, edit, commit, or run git commands in ' + board.repoPath + ' — it is the main repository.',
    '- When a tool needs a path, use the absolute worktree path above (or cd into it first).',
    '- Your changes live on branch ' + branchName + ', branched from ' + board.mainBranch + '.',
    '- Work freely: the main repository is isolated from everything you do in the worktree.',
    '- Commit your work on ' + branchName + ' with clear messages. Do not push.',
    '',
    '## Heartbeat (required)',
    '',
    'While you work, keep the progress file fresh so the kanban board can monitor',
    'you. Write JSON to ' + worktreePath + '/' + HEARTBEAT_FILE,
    '(at least once per long-running step and after each milestone):',
    '',
    '```json',
    '{ "progress": 40, "note": "implemented parser; now writing tests" }',
    '```',
    '',
    '- progress is an integer 0-100.',
    '- A run that does not update this file (or otherwise make progress) is',
    '  stopped automatically.',
    '',
    '## Definition of done',
    '',
    "1. The task's acceptance criteria are implemented and self-tested (in the worktree).",
    '2. git status in the worktree shows only intended changes; commit them on ' + branchName + '.',
    '3. Update the heartbeat file to progress: 100.',
    '',
    '## Completion report',
    '',
    'Finish with a concise summary: what changed, how it was verified, and any',
    'follow-ups. A human will review your diff before it is merged.',
  ].join('\n')
}

export const DISPATCH_TITLE_HINT = 'herness-kanban dispatch'

/**
 * Req 3 — seed message for a task-scoped refinement discussion session.
 *
 * The context is deliberately limited to THIS card: title, description,
 * comments, events, and attempt history. Nothing else on the board (or in any
 * other session) is included, so the conversation stays focused on the task.
 */
export function discussionPrompt(task: Task, board: { name: string }): string {
  const lines: string[] = [
    'You are the refinement conversation for one kanban task card.',
    'Everything below is the card\'s full context — it is the ONLY task context you have.',
    '',
    '## Card',
    '',
    '**Task id:** ' + task.id,
    '**Title:** ' + task.title,
    '**Priority:** ' + task.priority + (task.assignee ? '  **Assignee:** ' + task.assignee : ''),
    '**Board:** ' + board.name,
    '**Column:** ' + task.columnId + (task.isBlocked ? ' (blocked' + (task.blockReason ? ': ' + task.blockReason : '') + ')' : ''),
    '',
    '### Description',
    '',
    task.description || '(no description yet — help the user write one)',
  ]

  if (task.comments.length > 0) {
    lines.push('', '### Discussion history (comments)', '')
    for (const comment of task.comments) {
      lines.push('- **' + comment.author + '** (' + new Date(comment.createdAt).toISOString() + '): ' + comment.content.replace(/\n/g, '\n  '))
    }
  }

  if (task.attempts.length > 0) {
    lines.push('', '### Execution history', '')
    for (const attempt of task.attempts) {
      const when = new Date(attempt.startedAt).toISOString()
      const details: string[] = [attempt.status]
      if (attempt.error) details.push('error: ' + attempt.error)
      if (attempt.resultSummary) details.push('summary: ' + attempt.resultSummary)
      if (attempt.diffSummary) details.push('diff: ' + attempt.diffSummary)
      lines.push('- ' + when + ' — ' + details.join(' · '))
    }
  }

  lines.push(
    '',
    '### Event timeline',
    '',
    ...task.events.map((ev) => '- ' + new Date(ev.timestamp).toISOString() + ' — ' + ev.type + (summarizeEvent(ev.data) ? ' (' + summarizeEvent(ev.data) + ')' : '')),
    '',
    '## Your job',
    '',
    'Help the user refine this task\'s requirements through conversation. Clarify goals,',
    'acceptance criteria, scope, and edge cases; propose concrete wording when helpful.',
    'When the user agrees on a requirement change, write it back to the card:',
    '',
    '- `herness_kanban_update_description` with the full new description (old versions are kept).',
    '- `herness_kanban_add_comment` to record decisions and reasoning.',
    '',
    'Never dispatch, execute, merge, delete, or move the task — this conversation refines only.',
  )
  return lines.join('\n')
}

/** Compact one-line view of event payload fields, for the timeline. */
function summarizeEvent(data: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of ['from', 'to', 'summary', 'error', 'branch', 'reason', 'actor', 'sessionId', 'commit']) {
    const value = data[key]
    if (typeof value === 'string' && value) parts.push(key + '=' + value.slice(0, 80))
  }
  return parts.join(' ')
}

