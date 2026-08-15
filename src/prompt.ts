/**
 * Prompts for dispatched agent sessions.
 *
 * The dispatch prompt instructs the agent to work inside its worktree, to
 * write the heartbeat progress file (AE-06), and to report a completion
 * summary. The session inherits the user's DSH model configuration (DS-06).
 */
import type { Task } from './types.js'
import { HEARTBEAT_FILE } from './scheduler.js'

export function dispatchPrompt(task: Task, boardName: string, mainBranch: string, branchName: string): string {
  return [
    'You are working on a kanban task inside an isolated Git worktree.',
    '',
    '## Task',
    '',
    '**Title:** ' + task.title,
    '**Priority:** ' + task.priority,
    '**Board:** ' + boardName,
    '',
    '### Description',
    '',
    task.description || '(no description — infer the goal from the title and the repository)',
    '',
    '## Your workspace',
    '',
    '- Your working directory is a dedicated Git worktree for this task.',
    '- Your changes live on branch ' + branchName + ', branched from ' + mainBranch + '.',
    '- Work freely: the main repository is isolated from everything you do here.',
    '- Commit your work on ' + branchName + ' with clear messages. Do not push.',
    '',
    '## Heartbeat (required)',
    '',
    'While you work, keep the progress file fresh so the kanban board can monitor',
    'you. Write JSON to ' + HEARTBEAT_FILE + ' relative to your working directory',
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
    "1. The task's acceptance criteria are implemented and self-tested.",
    '2. git status shows only intended changes; commit them on ' + branchName + '.',
    '3. Update the heartbeat file to progress: 100.',
    '',
    '## Completion report',
    '',
    'Finish with a concise summary: what changed, how it was verified, and any',
    'follow-ups. A human will review your diff before it is merged.',
  ].join('\n')
}

export const DISPATCH_TITLE_HINT = 'herness-kanban dispatch'

