/**
 * Execution & review tools: dispatch_task, stop_task, get_diff, merge_task,
 * revert_task, parse_conversation (DC-01).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { KanbanService } from '../service.js'

const attemptOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attemptId: { type: 'string', required: true },
    taskId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'running', 'success', 'failed', 'stopped'] },
    branchName: { type: 'string' },
    worktreePath: { type: 'string' },
  },
} as const

export function registerExecutionTools(ctx: { tools: { register(definition: unknown): () => void } }, service: KanbanService) {
  ctx.tools.register(defineTool({
    name: 'herness_kanban_dispatch_task',
    description: 'Dispatch a todo task to a DSH agent for execution. The card moves to doing, gets its own Git worktree and branch (herness-task-<id>), and runs with the user\'s model config. Only cards in the todo column can be dispatched (Req 2). Up to 5 tasks run in parallel; extra dispatches queue. On success the card moves to review; on failure it returns to todo with the error summary (AE-01..AE-04).',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id to dispatch (must be in todo).' },
      runner: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional execution options for this dispatch.',
        properties: {
          mode: { type: 'string', enum: ['agent', 'api'], description: 'agent = DSH agent with optional preset; api = direct model route without an agent preset.' },
          agentPreset: { type: 'string', description: 'Agent preset/mode id (standard, code, minimal, cordis, ...).' },
          provider: { type: 'string', description: 'Provider route override.' },
          model: { type: 'string', description: 'Model id override.' },
          reasoningEffort: { type: 'string', description: 'Reasoning/thinking effort override.' },
          maxTokens: { type: 'number', description: 'Max output tokens override.' },
        },
      },
    },
    output: {
      schema: attemptOutput,
      render: (_args, value) => [{ type: 'text', text: 'Dispatched ' + value.taskId + ' (attempt ' + value.attemptId + ') on branch ' + value.branchName }],
    },
    execute: async (args) => {
      const attempt = await service.dispatch(String(args.taskId), (args.runner ?? {}) as Parameters<typeof service.dispatch>[1])
      return {
        attemptId: attempt.id,
        taskId: attempt.taskId,
        status: attempt.status,
        branchName: attempt.branchName,
        worktreePath: attempt.worktreePath,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Dispatch task', kind: 'other', rawInput: { taskId: args.taskId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_stop_task',
    description: 'Stop a running (or queued) task. The agent session is cancelled and the card returns to todo (AE-05).',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { stopped: { type: 'boolean', required: true }, taskId: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: 'Stop requested for ' + value.taskId }],
    },
    execute: async (args) => {
      await service.stop(args.taskId)
      return { stopped: true, taskId: args.taskId }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Stop task', kind: 'other', rawInput: { taskId: args.taskId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_get_diff',
    description: 'Get the full diff an execution produced: per-file unified diffs, additions/deletions, and conflict status. The diff compares the main branch with the task branch of the latest attempt (CR-01, CR-02, CR-06).',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id whose diff to inspect.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          filesChanged: { type: 'integer', required: true },
          additions: { type: 'integer', required: true },
          deletions: { type: 'integer', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: ['added', 'deleted', 'modified', 'renamed'] },
                additions: { type: 'integer', required: true },
                deletions: { type: 'integer', required: true },
                diff: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'Diff for ' + value.taskId + ': ' + value.filesChanged + ' file(s), +' + value.additions + '/-' + value.deletions + '\n' +
          value.files.map((f: { path: string; kind: string; additions: number; deletions: number }) => '  ' + f.kind + ' ' + f.path + ' (+' + f.additions + '/-' + f.deletions + ')').join('\n'),
      }],
    },
    execute: async (args) => {
      const summary = await service.getDiff(args.taskId)
      return {
        taskId: args.taskId,
        filesChanged: summary.filesChanged,
        additions: summary.additions,
        deletions: summary.deletions,
        files: summary.files.map((f) => ({ path: f.path, kind: f.kind, additions: f.additions, deletions: f.deletions, diff: f.diff })),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Get task diff', kind: 'other', rawInput: { taskId: args.taskId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_merge_task',
    description: 'Merge an approved task into the main branch: pending changes on the task branch are committed, the branch merges with --no-ff, the worktree is destroyed, and the card moves to done. ONLY call this after a human explicitly approved the diff (CR-03). Only cards in review can be merged (Req 2).',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id (must be in review).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          merged: { type: 'boolean', required: true },
          commit: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'Merged ' + value.taskId + (value.commit ? ' → ' + value.commit.slice(0, 12) : '') }],
    },
    execute: async (args) => {
      const result = await service.mergeTask(args.taskId, 'agent')
      return { taskId: result.task.id, merged: true, commit: result.commit }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Merge task', kind: 'other', rawInput: { taskId: args.taskId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_reject_task',
    description: 'Reject a reviewed task WITHOUT rolling back the merge: destroy the worktree, record the review notes as a comment, and return the card to todo for modification. The merged code stays on main, so the card can accumulate new content and be re-dispatched to continue (CR-04a). This is the ONLY way a review card goes back to todo without touching main (Req 2).',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id (must be in review).' },
      reason: { type: 'string', required: true, description: 'Review rejection notes; recorded on the card.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          rejected: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'Rejected ' + value.taskId + '; card returned to todo with review notes (merge kept).' }],
    },
    execute: async (args) => {
      const result = await service.rejectTask(args.taskId, args.reason, 'agent')
      return { taskId: result.task.id, rejected: true }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Reject task', kind: 'other', rawInput: { taskId: args.taskId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_revert_task',
    description: 'Reject a reviewed task AND roll it back: revert its merge on the main branch (when merged), destroy the worktree, record the review notes as a comment, and return the card to todo. Use this when the merged changes must be undone; use reject_task instead when the code should stay and the card just needs more work (CR-04).',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id (must be in review).' },
      reason: { type: 'string', required: true, description: 'Review rejection notes; recorded on the card.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          reverted: { type: 'boolean', required: true },
          commit: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'Reverted ' + value.taskId + '; card returned to todo with review notes.' }],
    },
    execute: async (args) => {
      const result = await service.revertTask(args.taskId, args.reason, 'agent')
      return { taskId: result.task.id, reverted: true, commit: result.commit }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Revert task', kind: 'other', rawInput: { taskId: args.taskId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_parse_conversation',
    description: '✨ Analyze the current conversation and decompose it into kanban tasks. Each extracted task becomes a card with title, description, priority, and a link to this session. Near-duplicate cards are skipped (DC-01..DC-04). Call this when the user says things like "turn this discussion into tasks".',
    parameters: {
      boardId: { type: 'string', required: true, description: 'Board to create the tasks on.' },
      conversation: { type: 'string', description: 'Conversation text to analyze; when omitted, the calling session\'s recent transcript is used.' },
      linkDependencies: { type: 'boolean', description: 'Link dependsOn edges as parent/subtask relations (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'integer', required: true },
          skippedDuplicates: { type: 'integer', required: true },
          dependencyLinked: { type: 'integer', required: true },
          taskIds: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'Created ' + value.created + ' task(s)' + (value.skippedDuplicates ? ' (skipped ' + value.skippedDuplicates + ' duplicate(s))' : '') + (value.dependencyLinked ? ' with ' + value.dependencyLinked + ' dependency link(s)' : '') + '.',
      }],
    },
    execute: async (args, exec) => {
      const result = await service.parseConversation({
        boardId: args.boardId,
        text: args.conversation,
        sessionId: exec.agent?.id,
        linkDependencies: args.linkDependencies ?? true,
        callerAgent: exec.agent,
      })
      return {
        created: result.created.length,
        skippedDuplicates: result.skippedDuplicates,
        dependencyLinked: result.dependencyLinked,
        taskIds: result.created.map((t) => t.id),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Parse conversation into tasks', kind: 'other', rawInput: { boardId: args.boardId } }),
  }))
}
