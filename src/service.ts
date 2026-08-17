/**
 * KanbanService — the single business facade shared by the 19 agent tools and
 * the RPC endpoint. Tools and RPC stay thin; every invariant lives here.
 */
import { basename } from 'node:path'
import { branchNameFor } from './ids.js'
import { GitService } from './git.js'
import { createParsedTasks, normalizeParseResult, PARSE_SYSTEM_PROMPT, type ParsedTaskInput } from './parse.js'
import { SchedulerService, type DispatchRunnerOptions } from './scheduler.js'
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

/**
 * Req 2 — the only manual column moves allowed on the 4-column workflow.
 *
 * todo → done and done → todo are manual open/close; everything else goes
 * through its own lifecycle entry point:
 *   todo → doing: herness_kanban_dispatch_task (scheduler)
 *   doing → review: automatic after a successful run
 *   doing → todo: herness_kanban_stop_task / settle
 *   review → done: herness_kanban_merge_task
 *   review → todo: herness_kanban_revert_task
 */
const TRANSITION_ERRORS: Record<ColumnId, Partial<Record<ColumnId, string>>> = {
  todo: {
    doing: '进行中只能通过派发任务（herness_kanban_dispatch_task）进入',
    review: '审查中只能由执行成功后自动进入',
  },
  doing: {
    review: '审查中只能由执行成功后自动进入',
    done: '请先完成审查流程（合并后自动进入已完成）',
  },
  review: {
    todo: '审查中的任务只能通过「驳回到待办」（herness_kanban_reject_task）或「回滚」（herness_kanban_revert_task）返回待办',
    done: '审查中的任务只能通过「审查通过并合并」（herness_kanban_merge_task）完成',
    doing: '只有待办任务可以派发',
  },
  done: {
    doing: '只有待办任务可以派发；如需返工请先移回待办',
    review: '已完成的任务无需再次审查；如需返工请先移回待办',
  },
}

export type { DispatchRunnerOptions }

export interface DispatchCatalogPreset {
  id: string
  name: string
  description?: string
  broken?: string
}

export interface DispatchCatalogReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface DispatchCatalogModel {
  id: string
  name: string
  reasoningEfforts?: DispatchCatalogReasoningEffort[]
  defaultEffort?: string
}

export interface DispatchCatalogProvider {
  id: string
  name: string
  models: DispatchCatalogModel[]
}

export interface DispatchCatalog {
  presets: DispatchCatalogPreset[]
  providers: DispatchCatalogProvider[]
  defaults: {
    mode?: 'agent' | 'api'
    agentPreset?: string
    provider?: string
    model?: string
    reasoningEffort?: string
  }
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
  /** Build the dispatch catalog for the UI (presets, providers, models, reasoning efforts). */
  getDispatchCatalog?: () => Promise<DispatchCatalog>
  /** Spawn a task-scoped refinement discussion session; resolves to its session id. */
  startDiscussionSession?: (task: Task, board: Board) => Promise<string>
  /** Attach a session to a workspace (directory + display title). Best-effort. */
  onSessionWorkspace?: (path: string, title: string, sessionId: string) => Promise<void>
  /** Called after a worktree directory is destroyed so its workspace record can be cleaned up. */
  onWorktreeRemoved?: (worktreePath: string) => void
}

export class KanbanService {
  readonly store: KanbanStore
  readonly git: GitService
  readonly scheduler: SchedulerService
  private readonly complete: (system: string, user: string, agent?: CallerAgent) => Promise<string>
  private readonly readSessionTranscript?: (sessionId: string) => Promise<Array<{ role: string; content: string }>>
  private readonly notify?: (title: string, message: string, kind?: 'success' | 'error' | 'info') => void
  private readonly getDispatchCatalog?: () => Promise<DispatchCatalog>
  private readonly startDiscussionSession?: (task: Task, board: Board) => Promise<string>
  private readonly onSessionWorkspace?: (path: string, title: string, sessionId: string) => Promise<void>
  private readonly onWorktreeRemoved?: (worktreePath: string) => void

  constructor(options: KanbanServiceOptions) {
    this.store = options.store
    this.git = options.git
    this.scheduler = options.scheduler
    this.complete = options.complete
    this.readSessionTranscript = options.readSessionTranscript
    this.notify = options.notify
    this.getDispatchCatalog = options.getDispatchCatalog
    this.startDiscussionSession = options.startDiscussionSession
    this.onSessionWorkspace = options.onSessionWorkspace
    this.onWorktreeRemoved = options.onWorktreeRemoved
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
    // Deleting a board with a live attempt would orphan its agent session and
    // worktree — refuse until every task is stopped.
    const busy = this.store.listTasks(id).filter((t) =>
      t.attempts.some((a) => a.status === 'running' || a.status === 'pending') || this.scheduler.isRunning(t.id),
    )
    if (busy.length > 0) {
      throw new InvalidStateError('看板下仍有任务在运行（' + busy.map((t) => t.id).join(', ') + '），请先停止后再删除项目')
    }
    const worktrees = await this.git.listWorktrees(board.repoPath)
    await this.git.cleanupBoardWorktrees(board)
    for (const wt of worktrees) this.onWorktreeRemoved?.(wt.path)
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
    if (input.columnId !== undefined) {
      const current = this.store.getTask(id)
      if (input.columnId !== current.columnId) {
        // Req 2: the 4-column workflow is a state machine. Only the listed
        // manual moves are allowed; everything else must go through its own
        // lifecycle entry point (dispatch / settle / merge / revert).
        const reason = TRANSITION_ERRORS[current.columnId]?.[input.columnId]
        if (reason) {
          throw new InvalidStateError('不允许从 [' + current.columnId + '] 移到 [' + input.columnId + ']：' + reason)
        }
      }
    }
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
        this.onWorktreeRemoved?.(attempt.worktreePath)
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

  /**
   * Append a dated detail section to a card's description (TM-10): keeps the
   * accumulated context intact while the card gains new requirements. Used by
   * the board UI's 「✏️ 补充细节」 so the user never has to leave the board.
   */
  async appendDetail(taskId: string, content: string, actor = 'user'): Promise<Task> {
    const task = this.store.getTask(taskId)
    const body = content.trim()
    if (!body) return task
    const stamp = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const label = stamp.getFullYear() + '-' + pad(stamp.getMonth() + 1) + '-' + pad(stamp.getDate()) + ' ' + pad(stamp.getHours()) + ':' + pad(stamp.getMinutes())
    const section = '\n\n---\n### 📝 补充 · ' + label + '\n\n' + body
    return this.store.updateTask(taskId, { description: task.description + section }, actor)
  }

  // ------------------------------------------------------------------
  // Execution (AE-01..AE-08)
  // ------------------------------------------------------------------

  async dispatch(taskId: string, runner: DispatchRunnerOptions = {}) {
    const attempt = await this.scheduler.dispatch(taskId, runner)
    this.notify?.('任务已派发', this.store.getTask(taskId).title, 'info')
    return attempt
  }

  async dispatchCatalog(): Promise<DispatchCatalog> {
    if (!this.getDispatchCatalog) throw new Error('dispatch catalog is not available')
    return this.getDispatchCatalog()
  }

  async stop(taskId: string): Promise<void> {
    await this.scheduler.stop(taskId)
  }

  // ------------------------------------------------------------------
  // Task-scoped refinement discussion (Req 3)
  // ------------------------------------------------------------------

  /**
   * Req 3 — open a dedicated conversation to refine a todo card's
   * requirements. The spawned session's context contains ONLY this card's
   * content (description, comments, events, attempts); the user chats with it
   * in the GUI and the agent writes agreed changes back onto the card.
   */
  async startDiscussion(taskId: string): Promise<{ taskId: string; sessionId: string }> {
    const task = this.store.getTask(taskId)
    if (task.columnId !== 'todo') {
      throw new InvalidStateError('只有待办（todo）任务可以开启细化对话；当前状态 [' + task.columnId + ']')
    }
    if (this.scheduler.isRunning(taskId)) throw new InvalidStateError('任务正在执行，无法开启细化对话')
    if (!this.startDiscussionSession) throw new Error('discussion sessions are not available in this deployment')
    const board = this.store.getBoard(task.boardId)
    const sessionId = await this.startDiscussionSession(task, board)
    // land the session in the project workspace so it is never “ungrouped”
    if (this.onSessionWorkspace) {
      try {
        await this.onSessionWorkspace(board.repoPath, board.name, sessionId)
      } catch {
        // best-effort — the conversation itself is already live
      }
    }
    await this.store.recordEvent(taskId, 'discussion_started', { sessionId })
    this.notify?.('任务细化对话已开启', task.title + ' — 在左侧工作区找到该会话继续对话', 'info')
    return { taskId, sessionId }
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
    // Req 2: review is the only gate into done — merging requires a review card.
    if (task.columnId !== 'review') {
      throw new InvalidStateError('只有审查中（review）的任务可以合并；当前状态 [' + task.columnId + ']')
    }
    const board = this.store.getBoard(task.boardId)
    const attempt = task.attempts[task.attempts.length - 1]
    const branch = attempt?.branchName ?? branchNameFor(task)
    const prepared = await this.git.prepareForMerge(board, task, attempt)
    const commit = await this.git.merge(board.repoPath, board.mainBranch, branch, task.id)
    // destroy the worktree + branch after merging (workflow: worktree destroyed on merge)
    if (attempt?.worktreePath) {
      await this.git.removeWorktree(board.repoPath, attempt.worktreePath, branch, true).catch(() => undefined)
      this.onWorktreeRemoved?.(attempt.worktreePath)
    }
    const updated = await this.store.updateTask(taskId, { columnId: 'done' }, actor)
    await this.store.recordEvent(taskId, 'merged', { commit, branch, changes: prepared.hasChanges })
    await this.store.recordEvent(taskId, 'review_approved', { commit, actor })
    this.notify?.('已合并', task.title + ' → ' + board.mainBranch, 'success')
    void this.scheduler.onTaskCompleted(taskId)
    return { task: updated, commit }
  }

  /**
   * CR-04a: reject WITHOUT rolling back the merge. The card returns to todo
   * so the reviewer can keep adding content (description, comments) and
   * re-dispatch; the merged code stays on main untouched.
   */
  async rejectTask(taskId: string, reason: string, actor = 'user'): Promise<ReviewResult> {
    return this.reviewReject(taskId, reason, actor, false)
  }

  /** CR-04: reject + rollback. Reverts the merge on main and returns the card to todo. */
  async revertTask(taskId: string, reason: string, actor = 'user'): Promise<ReviewResult> {
    return this.reviewReject(taskId, reason, actor, true)
  }

  private async reviewReject(taskId: string, reason: string, actor: string, rollback: boolean): Promise<ReviewResult> {
    const task = this.store.getTask(taskId)
    // Req 2: review's two exits — reject (→todo) and rollback (→todo).
    if (task.columnId !== 'review') {
      throw new InvalidStateError('只有审查中（review）的任务可以驳回；当前状态 [' + task.columnId + ']')
    }
    const board = this.store.getBoard(task.boardId)
    const attempt = task.attempts[task.attempts.length - 1]
    const branch = attempt?.branchName ?? branchNameFor(task)
    let commit: string | undefined
    if (rollback) {
      try {
        commit = await this.git.revert(board.repoPath, board.mainBranch, branch, task.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.notify?.('回滚失败', message, 'error')
        throw error
      }
    }
    if (attempt?.worktreePath) {
      await this.git.removeWorktree(board.repoPath, attempt.worktreePath, branch, true).catch(() => undefined)
      this.onWorktreeRemoved?.(attempt.worktreePath)
    }
    await this.addComment(taskId, '审查驳回: ' + (reason || '(no reason given)'), actor)
    const updated = await this.store.updateTask(taskId, { columnId: 'todo', isBlocked: false, blockReason: undefined }, actor)
    await this.store.recordEvent(taskId, rollback ? 'reverted' : 'rejected', { commit, reason, actor })
    await this.store.recordEvent(taskId, 'review_rejected', { commit, reason, actor })
    this.notify?.(rollback ? '已驳回并回滚' : '已驳回到待办', task.title + ' 回到待办', 'info')
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

