/**
 * Client data layer: RPC over the host's POST /herness-kanban/rpc plus the
 * /herness-kanban/events SSE channel for live updates (DS-04, NF-12).
 *
 * A tiny external store (useSyncExternalStore-compatible) feeds the board UI;
 * no DSH client services are required beyond the slot system.
 */

export type ColumnId = 'todo' | 'doing' | 'review' | 'done'
export type Priority = 'low' | 'medium' | 'high' | 'critical'

export interface Board {
  id: string
  name: string
  description?: string
  repoPath: string
  mainBranch: string
  columns: Column[]
  createdAt: number
  updatedAt: number
}

export interface Column {
  id: ColumnId
  label: string
  color: string
  collapsed?: boolean
}

export interface Attempt {
  id: string
  taskId: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'stopped'
  sessionId?: string
  worktreePath?: string
  branchName?: string
  startedAt: number
  finishedAt?: number
  resultSummary?: string
  diffSummary?: string
  progressLogs: string[]
  progress?: number
  error?: string
}

export interface Comment {
  id: string
  taskId: string
  author: string
  content: string
  createdAt: number
  filePath?: string
  lineNumber?: number
}

export interface Event {
  id: string
  taskId: string
  type: string
  data: Record<string, unknown>
  timestamp: number
}

export interface Task {
  id: string
  boardId: string
  title: string
  description: string
  priority: Priority
  assignee?: string
  columnId: ColumnId
  isBlocked?: boolean
  blockReason?: string
  schedule?: { type: 'interval'; interval: number } | { type: 'daily'; dailyTime: string }
  sessionId?: string
  threadId?: string
  parentTaskId?: string
  subtaskIds?: string[]
  createdAt: number
  updatedAt: number
  completedAt?: number
  attempts: Attempt[]
  comments: Comment[]
  events: Event[]
}

export interface FileDiff {
  path: string
  kind: 'added' | 'deleted' | 'modified' | 'renamed'
  oldPath?: string
  diff: string
  additions: number
  deletions: number
}

export interface DiffSummary {
  files: FileDiff[]
  additions: number
  deletions: number
  filesChanged: number
  mergeable: boolean
  hasConflicts?: boolean
  conflicts?: string[]
}

export interface Snapshot {
  boards: Board[]
  tasks: Task[]
  running: Record<string, { attemptId: string; progress?: number }>
  queue: number
}

export interface DispatchRunnerOptions {
  mode?: 'agent' | 'api'
  agentPreset?: string
  provider?: string
  model?: string
  maxTokens?: number
  reasoningEffort?: string
}

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

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  title: string
  message: string
}

const RPC_URL = '/herness-kanban/rpc'
const EVENTS_URL = '/herness-kanban/events'

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let snapshot: Snapshot = { boards: [], tasks: [], running: {}, queue: 0 }
let connected = false
let loading = false
let error: string | null = null
const listeners = new Set<() => void>()
const toastListeners = new Set<() => void>()
let toasts: Toast[] = []
let toastSeq = 1

function emit() {
  for (const fn of listeners) fn()
}

function emitToasts() {
  for (const fn of toastListeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): Snapshot {
  return snapshot
}

export function getLoading(): boolean {
  return loading
}

export function getError(): string | null {
  return error
}

export function isConnected(): boolean {
  return connected
}

export function subscribeToasts(fn: () => void): () => void {
  toastListeners.add(fn)
  return () => toastListeners.delete(fn)
}

export function getToasts(): Toast[] {
  return toasts
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emitToasts()
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export async function rpc<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  })
  const body = (await res.json()) as { ok: boolean; value?: T; error?: string }
  if (!body.ok || res.status >= 400) throw new Error(body.error ?? 'rpc failed: ' + method)
  return body.value as T
}

export async function refresh(): Promise<void> {
  if (loading) return
  loading = true
  emit()
  try {
    snapshot = await rpc<Snapshot>('state.snapshot')
    error = null
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    loading = false
    emit()
  }
}

export async function call(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await rpc(method, args)
  await refresh()
  return result
}

function pushToast(kind: Toast['kind'], title: string, message: string) {
  toasts = [...toasts, { id: toastSeq++, kind, title, message }].slice(-5)
  emitToasts()
  setTimeout(() => {
    toasts = toasts.filter((t) => !toasts.some((x) => x.id === t.id && Date.now() > 0))
  }, 0)
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

let retryTimer: ReturnType<typeof setTimeout> | null = null

export function connectEvents(): () => void {
  if (typeof EventSource === 'undefined') {
    // no SSE — fall back to polling
    const timer = setInterval(() => { void refresh() }, 2000)
    return () => clearInterval(timer)
  }
  const source = new EventSource(EVENTS_URL)
  source.onopen = () => {
    connected = true
    emit()
    void refresh()
  }
  source.onmessage = (ev) => {
    let event: { type: string; payload?: unknown } | null = null
    try {
      event = JSON.parse(ev.data)
    } catch {
      return
    }
    if (!event) return
    switch (event.type) {
      case 'board_changed':
        void refresh()
        break
      case 'task_started':
        void refresh()
        break
      case 'task_settled':
        void refresh()
        break
      case 'toast': {
        const payload = event.payload as { kind?: Toast['kind']; title?: string; message?: string }
        pushToast(payload.kind ?? 'info', payload.title ?? '', payload.message ?? '')
        break
      }
    }
  }
  source.onerror = () => {
    connected = false
    emit()
    source.close()
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(connectEvents, 3000)
  }
  return () => {
    if (retryTimer) clearTimeout(retryTimer)
    source.close()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const PRIORITY_BADGE: Record<Priority, string> = {
  low: '🟢',
  medium: '🟡',
  high: '🟠',
  critical: '🔴',
}

export const COLUMN_META: Record<ColumnId, { label: string; short: string; color: string }> = {
  todo: { label: '待办 Todo', short: '📋', color: '#94a3b8' },
  doing: { label: '进行中 Doing', short: '▶️', color: '#3b82f6' },
  review: { label: '审查中 Review', short: '👀', color: '#f59e0b' },
  done: { label: '已完成 Done', short: '✅', color: '#22c55e' },
}

export function taskBadges(task: Task): string[] {
  const badges: string[] = []
  const last = task.attempts[task.attempts.length - 1]
  if (task.schedule) badges.push('⏰')
  if (task.isBlocked) badges.push('🚫')
  if (last?.status === 'running') badges.push('🔴')
  if (last?.status === 'pending') badges.push('⏳')
  if (task.columnId === 'review') badges.push('👀')
  if (task.columnId === 'done') badges.push('✅')
  if (last?.status === 'failed' && task.columnId === 'todo') badges.push('⚠️')
  return badges
}

export function fmtTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toISOString().replace('T', ' ').slice(5, 16)
}
