/**
 * DSH storage domain for kanban data (DS-05).
 *
 * Two tables: boards and tasks. Task records embed their attempts, comments,
 * and events so a card is read and written atomically — the card IS the
 * accumulating context container (TM-10).
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { ColumnId, Priority } from './types.js'

const columnIdSchema = z.enum(['todo', 'doing', 'review', 'done'])
const prioritySchema = z.enum(['low', 'medium', 'high', 'critical'])
const scheduleSchema = z.union([
  z.object({ type: z.literal('interval'), interval: z.number().positive() }),
  z.object({ type: z.literal('daily'), dailyTime: z.string() }),
])

const columnSchema = z.object({
  id: columnIdSchema,
  label: z.string(),
  color: z.string(),
  collapsed: z.boolean().optional(),
})

const attemptSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  status: z.enum(['pending', 'running', 'success', 'failed', 'stopped']),
  sessionId: z.string().optional(),
  worktreePath: z.string().optional(),
  branchName: z.string().optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  resultSummary: z.string().optional(),
  diffSummary: z.string().optional(),
  progressLogs: z.array(z.string()),
  progress: z.number().optional(),
  error: z.string().optional(),
})

const commentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  author: z.string(),
  content: z.string(),
  createdAt: z.number(),
  filePath: z.string().optional(),
  lineNumber: z.number().optional(),
})

const eventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  type: z.enum([
    'created', 'column_changed', 'assigned', 'blocked', 'unblocked', 'scheduled',
    'dispatched', 'running', 'progress', 'completed', 'failed', 'stopped',
    'merged', 'reverted', 'rejected', 'commented', 'description_updated', 'review_requested',
    'review_approved', 'review_rejected', 'discussion_started', 'recovered',
  ]),
  data: z.record(z.string(), z.unknown()),
  timestamp: z.number(),
})

export const boardRecordSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  repoPath: z.string().min(1),
  mainBranch: z.string().min(1),
  columns: z.array(columnSchema).min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const taskRecordSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  title: z.string().min(1),
  description: z.string(),
  priority: prioritySchema,
  assignee: z.string().optional(),
  columnId: columnIdSchema,
  isBlocked: z.boolean().optional(),
  blockReason: z.string().optional(),
  schedule: scheduleSchema.optional(),
  sessionId: z.string().optional(),
  threadId: z.string().optional(),
  parentTaskId: z.string().optional(),
  subtaskIds: z.array(z.string()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
  attempts: z.array(attemptSchema),
  comments: z.array(commentSchema),
  events: z.array(eventSchema),
})

export type BoardRecord = z.infer<typeof boardRecordSchema>
export type TaskRecord = z.infer<typeof taskRecordSchema>
export type ColumnRecord = z.infer<typeof columnSchema>
export type AttemptRecord = z.infer<typeof attemptSchema>
export type CommentRecord = z.infer<typeof commentSchema>
export type EventRecord = z.infer<typeof eventSchema>
export type PriorityValue = Priority
export type ColumnIdValue = ColumnId

/** Global singleton: creation counters and the heartbeat kill-switch. */
export const kanbanGlobalSchema = z.object({
  /** Monotonic counters for human-friendly short ids (unused prefix of long ids). */
  boardCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  /** When set, every running attempt is terminated on next tick. */
  shutdownRequestedAt: z.number().optional(),
})

export const kanbanDomainSpec = defineDomain({
  name: 'herness_kanban',
  version: 1,
  global: {
    schema: kanbanGlobalSchema,
    initial: { boardCount: 0, taskCount: 0 },
  },
  tables: {
    boards: domainTable<string, BoardRecord>(boardRecordSchema),
    tasks: domainTable<string, TaskRecord>(taskRecordSchema),
  },
})

export type KanbanDomainSpec = typeof kanbanDomainSpec
