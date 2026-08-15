/**
 * KanbanService — the single business facade shared by the 17 agent tools and
 * the RPC endpoint. Tools and RPC stay thin; every invariant lives here.
 */
import { basename } from 'node:path'
import { branchNameFor } from './ids.js'
import { GitService } from './git.js'
import { createParsedTasks, normalizeParseResult, PARSE_SYSTEM_PROMPT, type ParsedTaskInput } from './parse.js'
import { SchedulerService } from './scheduler.js'
import { KanbanStore, InvalidStateError, NotFoundError, type CreateBoardInput, type CreateTaskInput, type UpdateTaskInput } from './store.js'
import { latestAttemptSummary } from './status.js'
import type { Board, ColumnId, DiffSummary, Priority, Schedule, Task } from './types.js'

export interface ParseConversationOptions {
  boardId: string
  /** Explicit conversation text; when omitted the bound session's tail is used. */
  text?: string
  sessionId?: string
  threadId?: string
  dedupeSimilarity?: number
  linkDependencies?: boolean
  /** The calling agent; its model config is reused for the parse call. */
  callerAgent?: CallerAgent
}

/** Minimal structural view of a DSH agent, keeps this module dependency-free. */
export interface CallerAgent {
  id?: string
  options?: { provider?: string; model?: string }
}

export interface ParseConversationResult {
  created: Task[]
  skippedDuplicates: number
  dependencyLinked: number
}

export interface ReviewResult {
  task: Task
  commit?: string
}

export interface KanbanServiceOptions {
  store: KanbanStore
  git: GitService
  scheduler: SchedulerService
  /** LLM completion seam for parse_conversation (DC-01). */
  complete: (system: string, user: string, agent?: CallerAgent) => Promise<string>
  /** Read the recent conversation of a session, newest last. */
  readSessionTranscript?: (sessionId: string) => Promise<Array<{ role: string; content: string }>>
  /** Called when a review decision lands (toasts, NF-13). */
  notify?: (title: string, message: string, kind?: 'success' | 'error' | 'info') => void
}

export class KanbanService {
  readonly store: KanbanStore
  readonly git: GitService
  readonly scheduler: SchedulerService
  private readonly complete: (system: string, user: string, agent?: CallerAgent) => Promise<string>
  private readonly readSessionTranscript?: (sessionId: string) => Promise<Array<{ role: string; content: string }>>
  private readonly notify?: (title: string, message: string, kind?: 'success' | 'error' | 'info') => void

  constructor(options: KanbanServiceOptions) {
    this.store = options.store
    this.git = options.git
    this.scheduler = options.scheduler
    this.complete = options.complete
    this.readSessionTranscript = options.readSessionTranscript
    this.notify = options.notify
  }

  // ------------------------------------------------------------------
  // Boards (PM-01..03)
  // ------------------------------------------------------------------

  listBoards(): Board[] {
    return this.store.listBoards()
  }

  /** Import a repo; auto git-init when the path is missing (PM-02). */
  async createBoard(input: CreateBoardInput & { mainBranch?: string }): Promise<Board> {
    const root = await this.git.ensureRepo(input.repoPath, input.mainBranch ?? 'main')
    const branch = input.mainBranch ?? (await this.git.defaultBranchName(root))
    const board = await this.store.createBoard({ ...input, repoPath: root }, branch)
    this.notify?.('看板创建成功', board.name + ' @ ' + root, 'success')
    return board
  }

  async updateBoard(id: string, patch: Parameters<KanbanStore['updateBoard']>[1]): Promise<Board> {
    return this.store.updateBoard(id, patch)
  }

  async deleteBoard(id: string): Promise<void> {
    const board = this.store.getBoard(id)
    await this.git.cleanupBoardWorktrees(board)
    await this.store.deleteBoard(id)
  }

  // ------------------------------------------------------------------
  // Tasks (TM-01..TM-10)
  // ------------------------------------------------------------------

  listTasks(boardId?: string): Task[] {
    return this.store.listTasks(boardId)
  }

  getTask(id: string): Task {
    return this.store.getTask(id)
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const task = await this.store.createTask(input)
    return task
  }

  async updateTask(id: string, input: UpdateTaskInput, actor = 'user'): Promise<Task> {
    const updated = await this.store.updateTask(id, input, actor)
    if (input.columnId === 'done') {
      void this.scheduler.onTaskCompleted(id)
    }
    return updated
  }

  async moveTask(id: string, columnId: ColumnId, actor = 'user'): Promise<Task> {
    return this.updateTask(id, { columnId }, actor)
  }

  async deleteTask(id: string): Promise<void> {
    const task = this.store.getTask(id)
    if (this.scheduler.isRunning(id)) throw new InvalidStateError('stop the running task before deleting it')
    if (task.columnId === 'review') {
      // abandon the review: destroy the worktree so no orphan state remains
      const board = this.store.getBoard(task.boardId)
      const attempt = task.attempts[task.attempts.length - 1]
      if (attempt?.worktreePath && attempt.branchName) {
        await this.git.removeWorktree(board.repoPath, attempt.worktreePath, attempt.branchName, true).catch(() => undefined)
      }
    }
    await this.store.deleteTask(id)
  }

  async addComment(taskId: string, content: string, author = 'user', anchor?: { filePath?: string; lineNumber?: number }) {
    return this.store.addComment(taskId, author, content, anchor)
  }

  async updateDescription(taskId: string, description: string, actor = 'agent'): Promise<Task> {
    return this.store.updateTask(taskId, { description }, actor)
  }

  // ------------------------------------------------------------------
  // Execution (AE-01..AE-08)
  // ------------------------------------------------------------------

  async dispatch(taskId: string) {
    const attempt = await this.scheduler.dispatch(taskId)
    this.notify?.('任务已派发', this.store.getTask(taskId).title, 'info')
    return attempt
  }

  async stop(taskId: string): Promise<void> {
    await this.scheduler.stop(taskId)
  }

  runningState(): Record<string, { attemptId: string; progress?: number }> {
    const out: Record<string, { attemptId: string; progress?: number }> = {}
    for (const task of this.store.listTasks()) {
      const attempt = task.attempts[task.attempts.length - 1]
      if (attempt && (attempt.status === 'running' || attempt.status === 'pending')) {
        out[task.id] = { attemptId: attempt.id, progress: attempt.progress }
      }
    }
    return out
  }

  // ------------------------------------------------------------------
  // Review (CR-01..CR-07)
  // ------------------------------------------------------------------

  /** CR-01/CR-02: full diff of the latest attempt vs the main branch. */
  async getDiff(taskId: string): Promise<DiffSummary> {
    const task = this.store.getTask(taskId)
    const board = this.store.getBoard(task.boardId)
    const attempt = task.attempts[task.attempts.length - 1]
    const branch = attempt?.branchName ?? branchNameFor(task)
    if (!(await this.git.branchExists(board.repoPath, branch))) {
      throw new NotFoundError('branch', branch)
    }
    return this.git.getDiffSummary(board.repoPath, board.mainBranch, branch)
  }

  async getDiffStat(taskId: string): Promise<string> {
    const task = this.store.getTask(taskId)
    const board = this.store.getBoard(task.boardId)
    const attempt = task.attempts[task.attempts.length - 1]
    const branch = attempt?.branchName ?? branchNameFor(task)
    return this.git.diffStat(board.repoPath, board.mainBranch, branch)
  }

  /** CR-03: approve + one-click merge. Commits leftovers, merges --no-ff, destroys the worktree. */
  async mergeTask(taskId: string, actor = 'user'): Promise<ReviewResult> {
    const task = this.store.getTask(taskId)
    const board = this.store.getBoard(task.boardId)
    const attempt = task.attempts[task.attempts.length - 1]
    const branch = attempt?.branchName ?? branchNameFor(task)
    const prepared = await this.git.prepareForMerge(board, task, attempt)
    const commit = await this.git.merge(board.repoPath, board.mainBranch, branch, task.id)
    // destroy the worktree + branch after merging (workflow: worktree destroyed on merge)
    if (attempt?.worktreePath) {
      await this.git.removeWorktree(board.repoPath, attempt.worktreePath, branch, true).catch(() => undefined)
    }
    const updated = await this.store.updateTask(taskId, { columnId: 'done' }, actor)
    await this.store.recordEvent(taskId, 'merged', { commit, branch, changes: prepared.hasChanges })
    await this.store.recordEvent(taskId, 'review_approved', { commit, actor })
    this.notify?.('已合并', task.title + ' → ' + board.mainBranch, 'success')
    void this.scheduler.onTaskCompleted(taskId)
    return { task: updated, commit }
  }

  /** CR-04: reject + revert. Rolls back the merge and returns the card to todo. */
  async revertTask(taskId: string, reason: string, actor = 'user'): Promise<ReviewResult> {
    const task = this.store.getTask(taskId)
    const board = this.store.getBoard(task.boardId)
    const attempt = task.attempts[task.attempts.length - 1]
    const branch = attempt?.branchName ?? branchNameFor(task)
    let commit: string | undefined
    try {
      commit = await this.git.revert(board.repoPath, board.mainBranch, branch, task.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.notify?.('回滚失败', message, 'error')
      throw error
    }
    if (attempt?.worktreePath) {
      await this.git.removeWorktree(board.repoPath, attempt.worktreePath, branch, true).catch(() => undefined)
    }
    await this.addComment(taskId, '审查驳回: ' + (reason || '(no reason given)'), actor)
    const updated = await this.store.updateTask(taskId, { columnId: 'todo', isBlocked: false, blockReason: undefined }, actor)
    await this.store.recordEvent(taskId, 'reverted', { commit, reason, actor })
    await this.store.recordEvent(taskId, 'review_rejected', { commit, reason, actor })
    this.notify?.('已驳回', task.title + ' 回到待办', 'info')
    return { task: updated, commit }
  }

  // ------------------------------------------------------------------
  // Conversation → tasks (DC-01..DC-04)
  // ------------------------------------------------------------------

  async parseConversation(options: ParseConversationOptions): Promise<ParseConversationResult> {
    const board = this.store.getBoard(options.boardId)
    void board
    let text = options.text
    if (!text && options.sessionId && this.readSessionTranscript) {
      const transcript = await this.readSessionTranscript(options.sessionId)
      text = transcript.map((m) => (m.role === 'user' ? '👤 User' : '🤖 Assistant') + ': ' + m.content.slice(0, 4000)).join('\n\n')
    }
    if (!text) throw new InvalidStateError('parse_conversation needs conversation text or a bound session')
    const raw = await this.complete(PARSE_SYSTEM_PROMPT, text.slice(0, 60_000), options.callerAgent)
    const parsed: ParsedTaskInput[] = normalizeParseResult(raw)
    return createParsedTasks(this.store, {
      boardId: options.boardId,
      tasks: parsed,
      sessionId: options.sessionId,
      threadId: options.threadId,
      dedupeSimilarity: options.dedupeSimilarity,
      linkDependencies: options.linkDependencies,
    })
  }

  /** Board snapshot for the web UI (DS-03). */
  snapshot() {
    return {
      boards: this.store.listBoards(),
      tasks: this.store.listTasks(),
      running: this.runningState(),
      queue: this.scheduler.pendingCount,
    }
  }

  /** Card digest used by tool outputs. */
  summarizeTask(task: Task): string {
    return [
      task.id,
      '[' + task.columnId + ']',
      task.title,
      task.priority !== 'medium' ? '(' + task.priority + ')' : '',
      latestAttemptSummary(task),
    ].filter(Boolean).join(' ')
  }
}

