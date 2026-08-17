/**
 * deepseek-herness-kanban — core data model.
 *
 * The shapes below mirror the plan's §6 data model: a board owns exactly four
 * workflow columns, a task accumulates every piece of context over its
 * lifetime (comments, events, attempts), and an attempt records one full
 * dispatch → worktree → review cycle.
 */

/** The four canonical workflow columns. Complex states are badges, not columns. */
export type ColumnId = 'todo' | 'doing' | 'review' | 'done'

export interface Column {
  id: ColumnId
  label: string
  color: string
  /** Empty columns auto-narrow; users may also collapse columns manually. */
  collapsed?: boolean
}

export type Priority = 'low' | 'medium' | 'high' | 'critical'

export type Schedule =
  | { type: 'interval'; interval: number } // minutes
  | { type: 'daily'; dailyTime: string } // HH:mm

export interface Board {
  id: string
  name: string
  description?: string
  /** Absolute path of the Git repository backing this board. */
  repoPath: string
  /** Main branch name (main / master). */
  mainBranch: string
  columns: Column[]
  createdAt: number
  updatedAt: number
}

export type AttemptStatus = 'pending' | 'running' | 'success' | 'failed' | 'stopped'

export interface TaskAttempt {
  id: string
  taskId: string
  status: AttemptStatus
  /** DSH agent session that executed this attempt. */
  sessionId?: string
  /** Absolute path of the Git worktree the agent worked in. */
  worktreePath?: string
  /** Branch name, `herness-task-<taskId>`. */
  branchName?: string
  startedAt: number
  finishedAt?: number
  /** One-line result summary shown on the card. */
  resultSummary?: string
  /** `files changed / insertions / deletions` digest. */
  diffSummary?: string
  /** Rolling progress logs; at most the last 50 lines. */
  progressLogs: string[]
  /** Progress percentage written by the heartbeat file. */
  progress?: number
  /** Error message when the attempt failed. */
  error?: string
}

export interface Comment {
  id: string
  taskId: string
  author: string
  content: string
  createdAt: number
  /** Present when the comment anchors to a reviewed file line. */
  filePath?: string
  lineNumber?: number
}

export type EventType =
  | 'created'
  | 'column_changed'
  | 'assigned'
  | 'blocked'
  | 'unblocked'
  | 'scheduled'
  | 'dispatched'
  | 'running'
  | 'progress'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'merged'
  | 'reverted'
  | 'rejected'
  | 'commented'
  | 'description_updated'
  | 'review_requested'
  | 'review_approved'
  | 'review_rejected'
  | 'discussion_started'
  | 'recovered'

export interface Event {
  id: string
  taskId: string
  type: EventType
  data: Record<string, unknown>
  timestamp: number
}

export interface Task {
  id: string
  boardId: string

  // ---- basic ----
  title: string
  /** Markdown description; every update is recorded as a versioned event. */
  description: string
  priority: Priority
  assignee?: string

  // ---- state ----
  columnId: ColumnId
  isBlocked?: boolean
  blockReason?: string

  // ---- schedule (⏰ badge) ----
  schedule?: Schedule

  // ---- conversation context (the core innovation) ----
  /** DSH session that created this task. */
  sessionId?: string
  /** Conversation thread the task was decomposed from. */
  threadId?: string

  // ---- parent / subtask ----
  parentTaskId?: string
  subtaskIds?: string[]

  // ---- audit ----
  createdAt: number
  updatedAt: number
  completedAt?: number

  // ---- execution history ----
  attempts: TaskAttempt[]

  // ---- collaboration ----
  comments: Comment[]
  events: Event[]
}

/** Snapshot of one file's change, for the diff review UI. */
export interface FileDiff {
  path: string
  /** one of: added | deleted | modified | renamed */
  kind: 'added' | 'deleted' | 'modified' | 'renamed'
  oldPath?: string
  /** Unified diff text (may be large; UI renders per file). */
  diff: string
  /** Stat: additions / deletions. */
  additions: number
  deletions: number
}

export interface DiffSummary {
  files: FileDiff[]
  additions: number
  deletions: number
  filesChanged: number
  /** Whether the merge target can fast-forward or needs --no-ff. */
  mergeable: boolean
  /** Conflict markers detected on the target branch. */
  hasConflicts?: boolean
  conflicts?: string[]
}

export const COLUMN_IDS: readonly ColumnId[] = ['todo', 'doing', 'review', 'done']

export const DEFAULT_COLUMNS: Column[] = [
  { id: 'todo', label: '待办 Todo', color: '#94a3b8' },
  { id: 'doing', label: '进行中 Doing', color: '#3b82f6' },
  { id: 'review', label: '审查中 Review', color: '#f59e0b' },
  { id: 'done', label: '已完成 Done', color: '#22c55e' },
]

export const PRIORITY_ORDER: Record<Priority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
}

export const PRIORITY_BADGE: Record<Priority, string> = {
  low: '🟢',
  medium: '🟡',
  high: '🟠',
  critical: '🔴',
}

export function isColumnId(value: unknown): value is ColumnId {
  return typeof value === 'string' && (COLUMN_IDS as readonly string[]).includes(value)
}

export function nextColumn(current: ColumnId, success: boolean): ColumnId {
  switch (current) {
    case 'todo':
    case 'doing':
      return success ? 'review' : 'todo'
    case 'review':
      return success ? 'done' : 'todo'
    case 'done':
      return 'done'
  }
}
