/**
 * Task tools: list/get/create/update/delete/move + add_comment +
 * update_description. Cards are the context container — every tool that
 * touches a card records an event (TM-10).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { COLUMN_IDS, PRIORITY_BADGE, type ColumnId, type Priority } from '../types.js'
import type { KanbanService } from '../service.js'

const taskDigest = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    boardId: { type: 'string', required: true },
    title: { type: 'string', required: true },
    columnId: { type: 'string', required: true, enum: [...COLUMN_IDS] },
    priority: { type: 'string', required: true, enum: ['low', 'medium', 'high', 'critical'] },
    assignee: { type: 'string' },
    isBlocked: { type: 'boolean' },
    sessionId: { type: 'string' },
    threadId: { type: 'string' },
    attempts: { type: 'integer', required: true },
    comments: { type: 'integer', required: true },
    latestAttemptStatus: { type: 'string' },
    latestError: { type: 'string' },
    createdAt: { type: 'integer', required: true },
    updatedAt: { type: 'integer', required: true },
  },
} as const

interface TaskDigest {
  id: string
  boardId: string
  title: string
  columnId: ColumnId
  priority: Priority
  assignee?: string
  isBlocked?: boolean
  sessionId?: string
  threadId?: string
  attempts: number
  comments: number
  latestAttemptStatus?: string
  latestError?: string
  createdAt: number
  updatedAt: number
}

function digestOf(service: KanbanService, taskId: string): TaskDigest {
  const task = service.getTask(taskId)
  const last = task.attempts[task.attempts.length - 1]
  // Only defined values may be included: `undefined` properties make the
  // tool result fail the harness's lossless-JSON snapshot validation.
  const digest: TaskDigest = {
    id: task.id,
    boardId: task.boardId,
    title: task.title,
    columnId: task.columnId,
    priority: task.priority,
    attempts: task.attempts.length,
    comments: task.comments.length,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
  if (task.assignee !== undefined) digest.assignee = task.assignee
  if (task.isBlocked !== undefined) digest.isBlocked = task.isBlocked
  if (task.sessionId !== undefined) digest.sessionId = task.sessionId
  if (task.threadId !== undefined) digest.threadId = task.threadId
  if (last?.status !== undefined) digest.latestAttemptStatus = last.status
  if (last?.error !== undefined) digest.latestError = last.error
  return digest
}

export function registerTaskTools(ctx: { tools: { register(definition: unknown): () => void } }, service: KanbanService) {
  ctx.tools.register(defineTool({
    name: 'herness_kanban_list_tasks',
    description: 'List task cards on a board (optionally filtered to one column: todo | doing | review | done). Cards carry status badges for schedule ⏰, blocked 🚫, running 🔴, review 👀.',
    parameters: {
      boardId: { type: 'string', required: true, description: 'Board id.' },
      columnId: { type: 'string', enum: [...COLUMN_IDS], description: 'Optional column filter.' },
      query: { type: 'string', description: 'Optional full-text filter on title/description/id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tasks: { type: 'array', required: true, items: taskDigest } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tasks.length === 0
          ? 'No tasks match.'
          : value.tasks.map((t: { id: string; columnId: string; title: string; priority: string; isBlocked?: boolean; latestAttemptStatus?: string }) => {
              const badge = PRIORITY_BADGE[t.priority as keyof typeof PRIORITY_BADGE] ?? ''
              const flags = [t.isBlocked ? '🚫' : '', t.latestAttemptStatus === 'running' ? '🔴' : '', t.latestAttemptStatus === 'pending' ? '⏳' : ''].join('')
              return t.id + ' [' + t.columnId + '] ' + badge + ' ' + t.title + flags
            }).join('\n'),
      }],
    },
    execute: async (args) => {
      const q = (args.query ?? '').toLowerCase()
      const tasks = service.listTasks(args.boardId).filter((t) => {
        if (args.columnId && t.columnId !== args.columnId) return false
        if (q && !(t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.id.includes(q))) return false
        return true
      })
      return { tasks: tasks.map((t) => digestOf(service, t.id)) }
    },
    presentCall: (args) => ({ card: 'generic', title: 'List tasks', kind: 'other', rawInput: { boardId: args.boardId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_get_task',
    description: 'Get one task card with its full accumulated context: description, comments, events, and every execution attempt with logs.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              boardId: { type: 'string', required: true },
              title: { type: 'string', required: true },
              description: { type: 'string', required: true },
              priority: { type: 'string', required: true, enum: ['low', 'medium', 'high', 'critical'] },
              assignee: { type: 'string' },
              columnId: { type: 'string', required: true, enum: [...COLUMN_IDS] },
              isBlocked: { type: 'boolean' },
              blockReason: { type: 'string' },
              schedule: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  type: { type: 'string', required: true, enum: ['interval', 'daily'] },
                  interval: { type: 'integer' },
                  dailyTime: { type: 'string' },
                },
              },
              sessionId: { type: 'string' },
              threadId: { type: 'string' },
              parentTaskId: { type: 'string' },
              subtaskIds: { type: 'array', items: { type: 'string' } },
              createdAt: { type: 'integer', required: true },
              updatedAt: { type: 'integer', required: true },
              completedAt: { type: 'integer' },
              comments: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    taskId: { type: 'string', required: true },
                    author: { type: 'string', required: true },
                    content: { type: 'string', required: true },
                    createdAt: { type: 'integer', required: true },
                    filePath: { type: 'string' },
                    lineNumber: { type: 'integer' },
                  },
                },
              },
              attempts: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    taskId: { type: 'string', required: true },
                    status: { type: 'string', required: true, enum: ['pending', 'running', 'success', 'failed', 'stopped'] },
                    sessionId: { type: 'string' },
                    branchName: { type: 'string' },
                    worktreePath: { type: 'string' },
                    startedAt: { type: 'integer', required: true },
                    finishedAt: { type: 'integer' },
                    resultSummary: { type: 'string' },
                    diffSummary: { type: 'string' },
                    progress: { type: 'integer' },
                    error: { type: 'string' },
                    progressLogs: { type: 'array', required: true, items: { type: 'string' } },
                  },
                },
              },
              events: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    taskId: { type: 'string', required: true },
                    type: { type: 'string', required: true },
                    data: { type: 'json' },
                    timestamp: { type: 'integer', required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const t = value.task
        const lines = [
          t.id + ' [' + t.columnId + '] ' + t.title + ' (' + t.priority + ')',
          t.description ? '— description: ' + t.description.slice(0, 1000) : '',
          '— comments: ' + t.comments.length + ', attempts: ' + t.attempts.length + ', events: ' + t.events.length,
        ]
        const last = t.attempts[t.attempts.length - 1]
        if (last) lines.push('— latest attempt: ' + last.status + (last.error ? ' — ' + last.error.slice(0, 300) : ''))
        return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
      },
    },
    execute: async (args) => {
      const task = service.getTask(args.taskId)
      return { task: JSON.parse(JSON.stringify(task)) }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Get task', kind: 'other', rawInput: { taskId: args.taskId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_create_task',
    description: 'Create a new task card on a board. When called from inside an agent session, the card is bound to that session (TM-09) so the originating conversation can be traced.',
    parameters: {
      boardId: { type: 'string', required: true, description: 'Board id.' },
      title: { type: 'string', required: true, description: 'Short imperative title.' },
      description: { type: 'string', description: 'Markdown description with goal and acceptance criteria. The card accumulates all future context, so be thorough.' },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Default: medium.' },
      assignee: { type: 'string', description: 'Optional assignee name.' },
      parentTaskId: { type: 'string', description: 'Optional parent task id (DC-04).' },
      schedule: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional schedule: { type: "interval", interval: minutes } or { type: "daily", dailyTime: "HH:mm" }.',
        properties: {
          type: { type: 'string', required: true, enum: ['interval', 'daily'] },
          interval: { type: 'integer' },
          dailyTime: { type: 'string' },
        },
      },
    },
    output: {
      schema: taskDigest,
      render: (_args, value) => [{ type: 'text', text: 'Task created: ' + value.id + ' · ' + value.title + ' [' + value.columnId + ']' }],
    },
    execute: async (args, exec) => {
      const sessionId = exec.agent?.id
      const task = await service.createTask({
        boardId: args.boardId,
        title: args.title,
        description: args.description ?? '',
        priority: args.priority,
        assignee: args.assignee,
        parentTaskId: args.parentTaskId,
        schedule: args.schedule as { type: 'interval'; interval: number } | { type: 'daily'; dailyTime: string } | undefined,
        sessionId,
      })
      return digestOf(service, task.id)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Create task', kind: 'other', rawInput: { boardId: args.boardId, title: args.title } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_update_task',
    description: 'Update a task card: title, description, priority, assignee, schedule, block/unblock, parent link, or column. Only provided fields change; the card timeline records the change (TM-10).',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
      title: { type: 'string' },
      description: { type: 'string', description: 'Replaces the description; the previous version is preserved in events.' },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      assignee: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Pass null to clear.' },
      schedule: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', required: true, enum: ['interval', 'daily'] },
            interval: { type: 'integer' },
            dailyTime: { type: 'string' },
          },
        }, { type: 'null' }],
        description: 'Pass null to clear.',
      },
      isBlocked: { type: 'boolean', description: '🚫 block flag.' },
      blockReason: { type: 'string', description: 'Why the card is blocked.' },
      columnId: { type: 'string', enum: [...COLUMN_IDS], description: 'Move to a column (prefer herness_kanban_move_task for explicit moves).' },
    },
    output: {
      schema: taskDigest,
      render: (_args, value) => [{ type: 'text', text: 'Task updated: ' + value.id + ' · ' + value.title }],
    },
    execute: async (args, exec) => {
      const updated = await service.updateTask(args.taskId, {
        title: args.title,
        description: args.description,
        priority: args.priority,
        assignee: args.assignee ?? undefined,
        schedule: args.schedule === null ? null : (args.schedule as { type: 'interval'; interval: number } | { type: 'daily'; dailyTime: string } | undefined),
        isBlocked: args.isBlocked,
        blockReason: args.blockReason,
        columnId: args.columnId,
      }, exec.agent ? 'agent' : 'user')
      return digestOf(service, updated.id)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Update task', kind: 'other', rawInput: { taskId: args.taskId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_delete_task',
    description: 'Delete a task card. A running task must be stopped first; a card under review also destroys its worktree.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'boolean', required: true }, taskId: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: 'Task deleted: ' + value.taskId }],
    },
    execute: async (args) => {
      await service.deleteTask(args.taskId)
      return { deleted: true, taskId: args.taskId }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Delete task', kind: 'other', rawInput: { taskId: args.taskId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_move_task',
    description: 'Move a card to a column: todo | doing | review | done. The 4-column workflow is a state machine (Req 2): only todo→done and done→todo are free manual moves. doing→todo is allowed (abandon). Everything else goes through its lifecycle entry point: todo→doing via dispatch_task, doing→review automatically after success, review→done via merge_task, review→todo via revert_task. Moving a card to done marks it complete and activates its subtasks (TA-03).',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
      columnId: { type: 'string', required: true, enum: [...COLUMN_IDS], description: 'Target column.' },
    },
    output: {
      schema: taskDigest,
      render: (_args, value) => [{ type: 'text', text: 'Moved ' + value.id + ' → ' + value.columnId }],
    },
    execute: async (args, exec) => {
      const task = await service.moveTask(args.taskId, args.columnId, exec.agent ? 'agent' : 'user')
      return digestOf(service, task.id)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Move task', kind: 'other', rawInput: { taskId: args.taskId, columnId: args.columnId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_add_comment',
    description: 'Add a comment to a task card. Comments form the discussion thread (TM-06): record decisions, failure analysis, review notes — optionally anchored to a file/line of a reviewed diff (CR-05).',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
      content: { type: 'string', required: true, description: 'Markdown comment text.' },
      author: { type: 'string', description: 'Author label; defaults to the calling agent.' },
      filePath: { type: 'string', description: 'Optional reviewed file the comment anchors to.' },
      lineNumber: { type: 'integer', description: 'Optional line number in that file.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          taskId: { type: 'string', required: true },
          createdAt: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'Comment added to ' + value.taskId + ' (' + value.id + ')' }],
    },
    execute: async (args, exec) => {
      const comment = await service.addComment(args.taskId, args.content, args.author ?? exec.agent?.id ?? 'agent', args.filePath ? { filePath: args.filePath, lineNumber: args.lineNumber } : undefined)
      return { id: comment.id, taskId: comment.taskId, createdAt: comment.createdAt }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Add comment', kind: 'other', rawInput: { taskId: args.taskId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_update_description',
    description: 'Update the task description to reflect new requirements, bugs, or details learned mid-flight. The previous version is preserved as a description_updated event — the card is a growing context container (TM-10).',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
      description: { type: 'string', required: true, description: 'New full Markdown description.' },
    },
    output: {
      schema: taskDigest,
      render: (_args, value) => [{ type: 'text', text: 'Description updated on ' + value.id + '; previous version kept in events.' }],
    },
    execute: async (args, exec) => {
      const task = await service.updateDescription(args.taskId, args.description, exec.agent?.id ?? 'agent')
      return digestOf(service, task.id)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Update description', kind: 'other', rawInput: { taskId: args.taskId } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_discuss_task',
    description: '💬 Start a dedicated refinement conversation for a todo task (Req 3). A new DSH session is spawned whose context contains ONLY this card (description, comments, events, attempts); the user continues the discussion in that session (shown under the project workspace in the GUI) to sharpen the requirements. The card must be in todo. Call this when the user wants to refine a task\'s requirements before dispatching it.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id (must be in todo).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'Refinement conversation started for ' + value.taskId + ' — session ' + value.sessionId + ' (context: this card only).' }],
    },
    execute: async (args) => service.startDiscussion(String(args.taskId)),
    presentCall: (args) => ({ card: 'generic', title: 'Discuss task', kind: 'other', rawInput: { taskId: args.taskId } }),
  }))
}
