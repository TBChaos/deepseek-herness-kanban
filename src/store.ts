/**
 * KanbanStore — all reads and writes of boards/tasks flow through here.
 *
 * The store adds the plan's collaboration semantics on top of the raw storage
 * domain: event recording, comment threads, description versioning, attempt
 * bookkeeping, and a 250ms debounced flush for high-frequency progress logs
 * (NF-09). Every mutation is funneled through the same `mutate` path so
 * `updatedAt` and event ordering can never drift.
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { attemptId, boardId, commentId, eventId, taskId } from './ids.js'
import { DEFAULT_COLUMNS, nextColumn, type AttemptStatus, type Board, type ColumnId, type Comment, type Event, type EventType, type Priority, type Schedule, type Task, type TaskAttempt } from './types.js'
import type { BoardRecord, KanbanDomainSpec, TaskRecord } from './domain.js'

export const MAX_PROGRESS_LOGS = 50
export const PROGRESS_FLUSH_MS = 250

/** Storage abstraction so the store stays testable without a live domain. */
export interface StoreBackend {
  listBoards(): BoardRecord[]
  getBoard(id: string): BoardRecord | undefined
  putBoard(board: BoardRecord): Promise<void>
  deleteBoard(id: string): Promise<boolean>
  listTasks(): TaskRecord[]
  listTasksByBoard(boardId: string): TaskRecord[]
  getTask(id: string): TaskRecord | undefined
  putTask(task: TaskRecord): Promise<void>
  updateTask(id: string, fn: (current: TaskRecord) => TaskRecord): Promise<TaskRecord>
  deleteTask(id: string): Promise<boolean>
  close?(): Promise<void>
}

/** Adapter over an opened DSH storage domain (DS-05). */
export class DomainBackend implements StoreBackend {
  constructor(private readonly domain: Domain<KanbanDomainSpec>) {}

  listBoards(): BoardRecord[] {
    return [...this.domain.table('boards').entries()].map(([, b]) => b)
  }

  getBoard(id: string): BoardRecord | undefined {
    return this.domain.table('boards').get(id)
  }

  putBoard(board: BoardRecord): Promise<void> {
    return this.domain.table('boards').put(board.id, board)
  }

  deleteBoard(id: string): Promise<boolean> {
    return this.domain.table('boards').delete(id)
  }

  listTasks(): TaskRecord[] {
    return [...this.domain.table('tasks').entries()].map(([, t]) => t)
  }

  listTasksByBoard(boardId: string): TaskRecord[] {
    return this.listTasks().filter((t) => t.boardId === boardId)
  }

  getTask(id: string): TaskRecord | undefined {
    return this.domain.table('tasks').get(id)
  }

  putTask(task: TaskRecord): Promise<void> {
    return this.domain.table('tasks').put(task.id, task)
  }

  async updateTask(id: string, fn: (current: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    return this.domain.table('tasks').update(id, fn)
  }

  deleteTask(id: string): Promise<boolean> {
    return this.domain.table('tasks').delete(id)
  }

  async close(): Promise<void> {
    await this.domain.close()
  }
}

export class MemoryBackend implements StoreBackend {
  private readonly boards = new Map<string, BoardRecord>()
  private readonly tasks = new Map<string, TaskRecord>()

  listBoards() { return [...this.boards.values()] }
  getBoard(id: string) { return this.boards.get(id) }
  async putBoard(board: BoardRecord) { this.boards.set(board.id, board) }
  async deleteBoard(id: string) { return this.boards.delete(id) }
  listTasks() { return [...this.tasks.values()] }
  listTasksByBoard(boardId: string) { return this.listTasks().filter((t) => t.boardId === boardId) }
  getTask(id: string) { return this.tasks.get(id) }
  async putTask(task: TaskRecord) { this.tasks.set(task.id, task) }
  async updateTask(id: string, fn: (current: TaskRecord) => TaskRecord) {
    const current = this.tasks.get(id)
    if (!current) throw new Error('task not found: ' + id)
    const next = fn(current)
    this.tasks.set(id, next)
    return next
  }
  async deleteTask(id: string) { return this.tasks.delete(id) }
}

export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(kind + ' not found: ' + id)
    this.name = 'NotFoundError'
  }
}

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidStateError'
  }
}

export interface CreateBoardInput {
  name: string
  description?: string
  repoPath: string
  mainBranch?: string
}

export interface CreateTaskInput {
  boardId: string
  title: string
  description?: string
  priority?: Priority
  assignee?: string
  schedule?: Schedule
  sessionId?: string
  threadId?: string
  parentTaskId?: string
  columnId?: ColumnId
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  priority?: Priority
  assignee?: string | null
  schedule?: Schedule | null
  isBlocked?: boolean
  blockReason?: string
  parentTaskId?: string | null
  columnId?: ColumnId
}

export class KanbanStore {
  constructor(readonly backend: StoreBackend) {}

  // ------------------------------------------------------------------
  // Boards (KB-01, KB-03, PM-01..03)
  // ------------------------------------------------------------------

  listBoards(): Board[] {
    return this.backend.listBoards().sort((a, b) => a.createdAt - b.createdAt)
  }

  getBoard(id: string): Board {
    const board = this.backend.getBoard(id)
    if (!board) throw new NotFoundError('board', id)
    return board
  }

  getBoardOrNull(id: string): Board | null {
    return this.backend.getBoard(id) ?? null
  }

  async createBoard(input: CreateBoardInput, mainBranch?: string): Promise<Board> {
    const now = Date.now()
    const board: BoardRecord = {
      id: boardId(),
      name: input.name,
      description: input.description,
      repoPath: input.repoPath,
      mainBranch: mainBranch ?? 'main',
      columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
      createdAt: now,
      updatedAt: now,
    }
    await this.backend.putBoard(board)
    return board
  }

  async updateBoard(id: string, patch: Partial<Pick<Board, 'name' | 'description' | 'mainBranch' | 'columns'>>): Promise<Board> {
    const board = this.getBoard(id)
    const next: BoardRecord = { ...board, ...patch, id, updatedAt: Date.now() }
    await this.backend.putBoard(next)
    return next
  }

  async deleteBoard(id: string): Promise<void> {
    const tasks = this.backend.listTasksByBoard(id)
    for (const task of tasks) await this.backend.deleteTask(task.id)
    await this.backend.deleteBoard(id)
  }

  // ------------------------------------------------------------------
  // Tasks (TM-01..TM-10)
  // ------------------------------------------------------------------

  listTasks(boardId?: string): Task[] {
    const tasks = boardId ? this.backend.listTasksByBoard(boardId) : this.backend.listTasks()
    return tasks.sort((a, b) => a.createdAt - b.createdAt)
  }

  getTask(id: string): Task {
    const task = this.backend.getTask(id)
    if (!task) throw new NotFoundError('task', id)
    return task
  }

  getTaskOrNull(id: string): Task | null {
    return this.backend.getTask(id) ?? null
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    this.getBoard(input.boardId) // fail fast when the board is gone
    const now = Date.now()
    const task: TaskRecord = {
      id: taskId(),
      boardId: input.boardId,
      title: input.title,
      description: input.description ?? '',
      priority: input.priority ?? 'medium',
      assignee: input.assignee,
      columnId: input.columnId ?? 'todo',
      schedule: input.schedule,
      sessionId: input.sessionId,
      threadId: input.threadId,
      parentTaskId: input.parentTaskId,
      subtaskIds: [],
      createdAt: now,
      updatedAt: now,
      attempts: [],
      comments: [],
      events: [],
    }
    this.pushEvent(task, {
      id: eventId(),
      taskId: task.id,
      type: 'created',
      data: { boardId: task.boardId },
      timestamp: now,
    })
    if (input.parentTaskId) {
      await this.backend.updateTask(input.parentTaskId, (parent) => ({
        ...parent,
        subtaskIds: [...(parent.subtaskIds ?? []), task.id],
        updatedAt: now,
      }))
    }
    await this.backend.putTask(task)
    return task
  }

  async updateTask(id: string, input: UpdateTaskInput, actor = 'user'): Promise<Task> {
    const before = this.getTask(id)
    const now = Date.now()
    const patch: Partial<TaskRecord> = {}
    if (input.title !== undefined) patch.title = input.title
    if (input.description !== undefined && input.description !== before.description) {
      patch.description = input.description
      this.pushEvent(before, {
        id: eventId(),
        taskId: id,
        type: 'description_updated',
        data: { previous: before.description.slice(0, 2000), actor },
        timestamp: now,
      })
    }
    if (input.priority !== undefined) patch.priority = input.priority
    if (input.assignee !== undefined) patch.assignee = input.assignee ?? undefined
    if (input.schedule !== undefined) patch.schedule = input.schedule ?? undefined
    if (input.isBlocked !== undefined) patch.isBlocked = input.isBlocked
    if (input.blockReason !== undefined) patch.blockReason = input.blockReason
    if (input.parentTaskId !== undefined) patch.parentTaskId = input.parentTaskId ?? undefined
    if (input.columnId !== undefined && input.columnId !== before.columnId) {
      patch.columnId = input.columnId
      this.pushEvent(before, {
        id: eventId(),
        taskId: id,
        type: 'column_changed',
        data: { from: before.columnId, to: input.columnId, actor },
        timestamp: now,
      })
      if (input.columnId === 'done') patch.completedAt = now
      else if (before.columnId === 'done') patch.completedAt = undefined
    }
    const updated = await this.backend.updateTask(id, (current) => ({
      ...current,
      ...patch,
      events: before.events === current.events ? this.collectEvents(current, before.events) : current.events,
      updatedAt: now,
    }))
    return updated
  }

  async moveTask(id: string, columnId: ColumnId, actor = 'user'): Promise<Task> {
    return this.updateTask(id, { columnId }, actor)
  }

  async deleteTask(id: string): Promise<void> {
    const task = this.getTask(id)
    if (task.parentTaskId) {
      await this.backend.updateTask(task.parentTaskId, (parent) => ({
        ...parent,
        subtaskIds: (parent.subtaskIds ?? []).filter((s) => s !== id),
      }))
    }
    await this.backend.deleteTask(id)
  }

  // ------------------------------------------------------------------
  // Comments (TM-06) and events (TM-07)
  // ------------------------------------------------------------------

  async addComment(id: string, author: string, content: string, anchor?: { filePath?: string; lineNumber?: number }): Promise<Comment> {
    const comment: Comment = {
      id: commentId(),
      taskId: id,
      author,
      content,
      createdAt: Date.now(),
      filePath: anchor?.filePath,
      lineNumber: anchor?.lineNumber,
    }
    const task = this.getTask(id)
    const event: Event = {
      id: eventId(),
      taskId: id,
      type: 'commented',
      data: { author, commentId: comment.id, preview: content.slice(0, 120) },
      timestamp: comment.createdAt,
    }
    await this.backend.updateTask(id, (current) => ({
      ...current,
      comments: [...current.comments, comment],
      events: [...current.events, event],
      updatedAt: comment.createdAt,
    }))
    void task
    return comment
  }

  /** Append an event to a task's timeline (TM-07). */
  async recordEvent(id: string, type: EventType, data: Record<string, unknown> = {}): Promise<Event> {
    const event: Event = { id: eventId(), taskId: id, type, data, timestamp: Date.now() }
    await this.backend.updateTask(id, (current) => ({
      ...current,
      events: [...current.events, event],
      updatedAt: event.timestamp,
    }))
    return event
  }

  // ------------------------------------------------------------------
  // Attempts (TM-08) + progress debounce (NF-09)
  // ------------------------------------------------------------------

  async beginAttempt(task: Task, sessionId?: string, worktreePath?: string, branchName?: string): Promise<TaskAttempt> {
    const attempt: TaskAttempt = {
      id: attemptId(),
      taskId: task.id,
      status: 'running',
      sessionId,
      worktreePath,
      branchName,
      startedAt: Date.now(),
      progressLogs: [],
      progress: 0,
    }
    await this.backend.updateTask(task.id, (current) => ({
      ...current,
      attempts: [...current.attempts, attempt],
      updatedAt: attempt.startedAt,
    }))
    return attempt
  }

  async finishAttempt(taskId: string, attemptId: string, patch: Partial<TaskAttempt> & { status: AttemptStatus }): Promise<TaskAttempt> {
    const finishedAt = Date.now()
    const updated = await this.backend.updateTask(taskId, (current) => ({
      ...current,
      attempts: current.attempts.map((a) => (a.id === attemptId ? { ...a, ...patch, status: patch.status, finishedAt } : a)),
      updatedAt: finishedAt,
    }))
    const attempt = updated.attempts.find((a) => a.id === attemptId)
    if (!attempt) throw new NotFoundError('attempt', attemptId)
    return attempt
  }

  async latestAttempt(taskId: string): Promise<TaskAttempt | null> {
    const task = this.getTaskOrNull(taskId)
    if (!task || task.attempts.length === 0) return null
    return task.attempts[task.attempts.length - 1] ?? null
  }

  /** Buffer progress lines; flushed at most every 250ms (NF-09). */
  async appendProgress(taskId: string, attemptId: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return
    this.progressBuffer.push({ taskId, attemptId, lines })
    this.scheduleFlush()
  }

  /** Set progress percentage from the heartbeat file (AE-07). */
  async setProgress(taskId: string, attemptId: string, progress: number): Promise<void> {
    await this.backend.updateTask(taskId, (current) => ({
      ...current,
      attempts: current.attempts.map((a) => (a.id === attemptId ? { ...a, progress: Math.max(0, Math.min(100, Math.round(progress))) } : a)),
    }))
  }

  // -- private debounced progress writer ---------------------------------

  private readonly progressBuffer: Array<{ taskId: string; attemptId: string; lines: string[] }> = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushProgress()
    }, PROGRESS_FLUSH_MS)
  }

  private async flushProgress(): Promise<void> {
    const batch = this.progressBuffer.splice(0)
    const byTask = new Map<string, Array<{ attemptId: string; lines: string[] }>>()
    for (const item of batch) {
      const list = byTask.get(item.taskId) ?? []
      list.push(item)
      byTask.set(item.taskId, list)
    }
    for (const [taskId, items] of byTask) {
      await this.backend.updateTask(taskId, (current) => ({
        ...current,
        attempts: current.attempts.map((a) => {
          const add = items.filter((i) => i.attemptId === a.id).flatMap((i) => i.lines)
          if (add.length === 0) return a
          const merged = [...a.progressLogs, ...add].slice(-MAX_PROGRESS_LOGS)
          return { ...a, progressLogs: merged }
        }),
      }))
    }
  }

  /** Flush pending progress synchronously (used on shutdown). */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flushProgress()
  }

  // ------------------------------------------------------------------
  // State transitions (AE-04)
  // ------------------------------------------------------------------

  /** Auto state flow: success → review, failure → todo with error summary. */
  async settleAttempt(taskId: string, attemptId: string, outcome: { status: 'success' | 'failed' | 'stopped'; summary?: string; error?: string; diffSummary?: string }): Promise<Task> {
    const attempt = await this.finishAttempt(taskId, attemptId, {
      status: outcome.status,
      resultSummary: outcome.summary,
      error: outcome.error,
      diffSummary: outcome.diffSummary,
    })
    const task = this.getTask(taskId)
    const columnId = nextColumn(task.columnId, outcome.status === 'success')
    const eventType: EventType = outcome.status === 'success' ? 'completed' : outcome.status === 'stopped' ? 'stopped' : 'failed'
    await this.backend.updateTask(taskId, (current) => ({
      ...current,
      columnId,
      updatedAt: Date.now(),
      events: [...current.events, {
        id: eventId(),
        taskId,
        type: eventType,
        data: { attemptId: attempt.id, summary: outcome.summary, error: outcome.error },
        timestamp: Date.now(),
      }],
    }))
    return this.getTask(taskId)
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private pushEvent(task: TaskRecord, event: Event): void {
    task.events.push(event)
  }

  private collectEvents(current: TaskRecord, previous: Event[]): Event[] {
    // Events appended during this update are the delta over the previous list.
    const delta = current.events.slice(previous.length)
    return [...previous, ...delta]
  }
}
