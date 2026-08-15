/**
 * SchedulerService — dispatch engine, heartbeat monitoring, and per-task
 * timers (AE-01..AE-08, TA-01..TA-04, NF-06, NF-10).
 *
 * The engine is transport-agnostic: the DSH session seam is injected as an
 * {@link AgentRunner}, so tests drive it with a fake agent.
 */
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { branchNameFor, clampProgress, worktreePathFor } from './ids.js'
import type { Board, Task, TaskAttempt } from './types.js'
import type { KanbanStore } from './store.js'
import { GitService } from './git.js'

export const DEFAULT_MAX_CONCURRENT = 5
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30 * 60 * 1000
export const HEARTBEAT_FILE = '.herness/heartbeat.json'

export interface DispatchOptions {
  task: Task
  board: Board
  attempt: TaskAttempt
  worktreePath: string
  branchName: string
}

export interface SessionOutcome {
  status: 'success' | 'failed' | 'stopped'
  summary?: string
  error?: string
}

export interface RunningSession {
  readonly sessionId?: string
  /** Resolves when the session settles. */
  wait(): Promise<SessionOutcome>
  /** Cooperative stop (AE-05). */
  stop(): Promise<void>
}

/** Spawns the DSH agent session bound to one task's worktree (DS-06). */
export interface AgentRunner {
  spawn(options: DispatchOptions): Promise<RunningSession>
}

export interface SchedulerOptions {
  maxConcurrent?: number
  heartbeatTimeoutMs?: number
  /** Called for each new progress line (drives the UI's console). */
  onProgress?: (taskId: string, attemptId: string, lines: string[]) => void
  /** Called when a run settles (drives toast notifications, NF-13). */
  onSettled?: (taskId: string, outcome: SessionOutcome) => void
  /** Called when a queued run starts. */
  onStart?: (taskId: string) => void
}

interface Run {
  taskId: string
  attemptId: string
  abort: AbortController
  session?: RunningSession
  heartbeat: { lastSignal: number; lastProgressFile: number }
  timer?: ReturnType<typeof setTimeout>
}

export class SchedulerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchedulerError'
  }
}

export class SchedulerService extends EventEmitter {
  readonly maxConcurrent: number
  readonly heartbeatTimeoutMs: number

  private readonly store: KanbanStore
  private readonly git: GitService
  private readonly runner: AgentRunner
  private readonly opts: Required<Pick<SchedulerOptions, 'onProgress' | 'onSettled' | 'onStart'>>

  private readonly runs = new Map<string, Run>()
  private readonly queue: Array<{ taskId: string; attemptId: string }> = []
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>()
  private disposed = false

  constructor(store: KanbanStore, gitService: GitService, runner: AgentRunner, options: SchedulerOptions = {}) {
    super()
    this.store = store
    this.git = gitService
    this.runner = runner
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
    this.opts = {
      onProgress: options.onProgress ?? (() => {}),
      onSettled: options.onSettled ?? (() => {}),
      onStart: options.onStart ?? (() => {}),
    }
  }

  get activeCount(): number {
    return this.runs.size
  }

  get pendingCount(): number {
    return this.queue.length
  }

  isRunning(taskId: string): boolean {
    return this.runs.has(taskId)
  }

  // ------------------------------------------------------------------
  // Dispatch (AE-01..AE-04)
  // ------------------------------------------------------------------

  async dispatch(taskId: string): Promise<TaskAttempt> {
    if (this.disposed) throw new SchedulerError('scheduler is disposed')
    if (this.runs.has(taskId)) throw new SchedulerError('task already running: ' + taskId)
    if (this.queue.some((q) => q.taskId === taskId)) throw new SchedulerError('task already queued: ' + taskId)
    const task = this.store.getTask(taskId)
    if (task.isBlocked) throw new SchedulerError('task is blocked' + (task.blockReason ? ': ' + task.blockReason : ''))
    const board = this.store.getBoard(task.boardId)

    // 1. isolated worktree + branch (AE-02)
    const worktree = await this.git.createWorktree(board, task)
    const attempt = await this.store.beginAttempt(task, undefined, worktree.path, worktree.branch)
    await this.store.recordEvent(taskId, 'dispatched', { attemptId: attempt.id, branch: worktree.branch, worktree: worktree.path })

    if (this.runs.size >= this.maxConcurrent) {
      this.queue.push({ taskId, attemptId: attempt.id })
      await this.store.updateTask(taskId, {})
      return attempt
    }
    void this.startRun(taskId, attempt.id)
    return attempt
  }

  private async startRun(taskId: string, attemptId: string): Promise<void> {
    if (this.disposed) return
    const task = this.store.getTaskOrNull(taskId)
    if (!task) return
    const board = this.store.getBoard(task.boardId)
    const attempt = task.attempts.find((a) => a.id === attemptId)
    if (!attempt) return
    const worktreePath = attempt.worktreePath ?? worktreePathFor(board, task)
    const branchName = attempt.branchName ?? branchNameFor(task)

    const abort = new AbortController()
    const run: Run = {
      taskId,
      attemptId,
      abort,
      heartbeat: { lastSignal: Date.now(), lastProgressFile: Date.now() },
    }
    this.runs.set(taskId, run)
    this.opts.onStart(taskId)
    await this.store.updateTask(taskId, { columnId: 'doing' })
    await this.store.recordEvent(taskId, 'running', { attemptId })

    try {
      const session = await this.runner.spawn({ task, board, attempt, worktreePath, branchName })
      run.session = session
      if (session.sessionId) {
        await this.store.backend.updateTask(taskId, (current) => ({
          ...current,
          attempts: current.attempts.map((a) => (a.id === attemptId ? { ...a, sessionId: session.sessionId } : a)),
        }))
      }
      // heartbeat watchdog (NF-10)
      run.timer = setInterval(() => this.checkHeartbeat(run), Math.min(30_000, Math.floor(this.heartbeatTimeoutMs / 2)))
      const outcome = await session.wait()
      await this.settle(taskId, attemptId, outcome, run)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.settle(taskId, attemptId, { status: 'failed', error: message, summary: '执行失败: ' + message }, run)
    } finally {
      clearInterval(run.timer)
      this.runs.delete(taskId)
      this.pump()
    }
  }

  private pump(): void {
    if (this.disposed) return
    while (this.runs.size < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()
      if (!next) break
      if (!this.runs.has(next.taskId)) void this.startRun(next.taskId, next.attemptId)
    }
  }

  private async settle(taskId: string, attemptId: string, outcome: SessionOutcome, run: Run): Promise<void> {
    const task = this.store.getTaskOrNull(taskId)
    if (!task) return
    let diffSummary: string | undefined
    if (outcome.status === 'success') {
      try {
        const board = this.store.getBoard(task.boardId)
        const attempt = task.attempts.find((a) => a.id === attemptId)
        const branch = attempt?.branchName ?? branchNameFor(task)
        const stat = await this.git.diffStat(board.repoPath, board.mainBranch, branch)
        diffSummary = stat.trim() || 'no changes'
      } catch {
        diffSummary = undefined
      }
    }
    await this.store.settleAttempt(taskId, attemptId, {
      status: outcome.status,
      summary: outcome.summary,
      error: outcome.error,
      diffSummary,
    })
    this.opts.onSettled(taskId, outcome)
    this.emit('settled', { taskId, attemptId, outcome })
    void run
  }

  /** Stop a running attempt: cancel the session, move the task back to todo (AE-05). */
  async stop(taskId: string): Promise<void> {
    const run = this.runs.get(taskId)
    const queuedIndex = this.queue.findIndex((q) => q.taskId === taskId)
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1)
      const task = this.store.getTaskOrNull(taskId)
      if (task) await this.store.settleAttempt(taskId, task.attempts[task.attempts.length - 1]?.id ?? '', { status: 'stopped', summary: '取消排队' })
      return
    }
    if (!run) throw new SchedulerError('task is not running: ' + taskId)
    run.abort.abort()
    await run.session?.stop()
  }

  // ------------------------------------------------------------------
  // Heartbeat (AE-06, NF-10): logs + progress file dual signal
  // ------------------------------------------------------------------

  private checkHeartbeat(run: Run): void {
    const task = this.store.getTaskOrNull(run.taskId)
    if (!task) return
    const attempt = task.attempts.find((a) => a.id === run.attemptId)
    if (!attempt?.worktreePath) return
    const heartbeatPath = attempt.worktreePath + '/' + HEARTBEAT_FILE
    if (existsSync(heartbeatPath)) {
      try {
        const stat = statSync(heartbeatPath)
        if (stat.mtimeMs > run.heartbeat.lastProgressFile) {
          run.heartbeat.lastProgressFile = stat.mtimeMs
          run.heartbeat.lastSignal = Date.now()
          const payload = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as { progress?: number }
          if (typeof payload.progress === 'number') {
            void this.store.setProgress(run.taskId, run.attemptId, clampProgress(payload.progress))
          }
        }
      } catch {
        // unreadable heartbeat file — ignore, the log signal still counts
      }
    }
    if (Date.now() - run.heartbeat.lastSignal > this.heartbeatTimeoutMs) {
      this.opts.onProgress(run.taskId, run.attemptId, ['[herness-kanban] heartbeat timeout after ' + Math.round(this.heartbeatTimeoutMs / 60000) + 'min — stopping'])
      run.abort.abort()
      void run.session?.stop()
    }
  }

  /** Feed session activity into the heartbeat log signal. */
  reportActivity(taskId: string, attemptId: string, lines: string[]): void {
    const run = this.runs.get(taskId)
    if (run && run.attemptId === attemptId) {
      run.heartbeat.lastSignal = Date.now()
      void this.store.appendProgress(taskId, attemptId, lines)
      this.opts.onProgress(taskId, attemptId, lines)
    }
  }

  // ------------------------------------------------------------------
  // Timers (TA-01..TA-04)
  // ------------------------------------------------------------------

  /** Arm the per-task schedule timers for every scheduled task. */
  armTimers(): void {
    for (const task of this.store.listTasks()) this.armTaskTimer(task)
  }

  armTaskTimer(task: Task): void {
    this.disarmTaskTimer(task.id)
    if (!task.schedule || this.disposed) return
    if (task.schedule.type === 'interval') {
      const minutes = Math.max(1, task.schedule.interval)
      const timer = setInterval(() => {
        this.activate(task.id)
      }, minutes * 60_000)
      this.timers.set(task.id, timer)
    } else if (task.schedule.type === 'daily') {
      const timer = setInterval(() => {
        this.checkDaily(task)
      }, 30_000)
      this.timers.set(task.id, timer)
    }
  }

  disarmTaskTimer(taskId: string): void {
    const timer = this.timers.get(taskId)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(taskId)
    }
  }

  /** Ensure every scheduled task has an armed timer (cheap periodic sweep). */
  reconcileTimers(): void {
    if (this.disposed) return
    for (const task of this.store.listTasks()) {
      if (task.schedule && !this.timers.has(task.id)) this.armTaskTimer(task)
      if (!task.schedule && this.timers.has(task.id)) this.disarmTaskTimer(task.id)
    }
  }

  private checkDaily(task: Task): void {
    if (task.schedule?.type !== 'daily') return
    const now = new Date()
    const hhmm = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0')
    if (hhmm === task.schedule.dailyTime) this.activate(task.id)
  }

  /** Timed activation: move a scheduled task from done back to todo (⏰). */
  private async activate(taskId: string): Promise<void> {
    const task = this.store.getTaskOrNull(taskId)
    if (!task || this.runs.has(taskId)) return
    if (task.columnId === 'done') {
      await this.store.moveTask(taskId, 'todo', 'schedule')
      await this.store.recordEvent(taskId, 'scheduled', { source: task.schedule })
    }
    if (task.columnId === 'todo') {
      this.dispatch(taskId).catch(() => undefined)
    }
  }

  /** TA-03: when a parent completes, activate its subtasks. */
  async onTaskCompleted(taskId: string): Promise<void> {
    const task = this.store.getTaskOrNull(taskId)
    if (!task) return
    for (const subtaskId of task.subtaskIds ?? []) {
      const subtask = this.store.getTaskOrNull(subtaskId)
      if (subtask && subtask.columnId === 'todo' && !this.runs.has(subtaskId)) {
        await this.store.recordEvent(subtaskId, 'scheduled', { source: { type: 'parent_completed', parentTaskId: taskId } })
        this.dispatch(subtaskId).catch(() => undefined)
      }
    }
  }

  /** Release every resource: sessions, timers, queue (NF-04). */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
    this.queue.length = 0
    for (const run of this.runs.values()) {
      run.abort.abort()
      await run.session?.stop().catch(() => undefined)
    }
    this.runs.clear()
    await this.store.flush()
  }
}
