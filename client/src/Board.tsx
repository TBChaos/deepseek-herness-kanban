import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  COLUMN_META, PRIORITY_BADGE, call, dismissToast, fmtTime, getError, getSnapshot, getToasts, isConnected,
  refresh, rpc, subscribe, subscribeToasts, taskBadges, type Board, type ColumnId, type DiffSummary,
  type DispatchCatalog, type DispatchRunnerOptions, type Snapshot, type Task, type Toast,
} from './api'
import { BOARD_CSS } from './styles'

const COLUMNS: ColumnId[] = ['todo', 'doing', 'review', 'done']

// ---------------------------------------------------------------------------
// open/close + selection + board stores (module level, shared across items)
// ---------------------------------------------------------------------------
let currentBoardId: string | null = null
let boardListeners = new Set<() => void>()
export function getCurrentBoardId(): string | null { return currentBoardId }
export function setCurrentBoardId(id: string | null): void {
  if (currentBoardId === id) return
  currentBoardId = id
  for (const fn of boardListeners) fn()
}
export function subscribeBoard(fn: () => void): () => void {
  boardListeners.add(fn)
  return () => boardListeners.delete(fn)
}
let open = false
let openListeners = new Set<() => void>()
export function isOpen(): boolean { return open }
export function setOpen(value: boolean): void {
  if (open === value) return
  open = value
  for (const fn of openListeners) fn()
}
export function subscribeOpen(fn: () => void): () => void {
  openListeners.add(fn)
  return () => openListeners.delete(fn)
}
let selectedTaskId: string | null = null
let selectedListeners = new Set<() => void>()
export function getSelectedTaskId(): string | null { return selectedTaskId }
export function selectTask(id: string | null): void {
  selectedTaskId = id
  for (const fn of selectedListeners) fn()
}
export function subscribeSelection(fn: () => void): () => void {
  selectedListeners.add(fn)
  return () => selectedListeners.delete(fn)
}

// ---------------------------------------------------------------------------
// shared tiny hooks
// ---------------------------------------------------------------------------
function useSnapshot(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
function useOpen(): boolean {
  return useSyncExternalStore(subscribeOpen, isOpen, isOpen)
}
function useSelected(): string | null {
  return useSyncExternalStore(subscribeSelection, getSelectedTaskId, getSelectedTaskId)
}
function useToasts(): Toast[] {
  return useSyncExternalStore(subscribeToasts, getToasts, getToasts)
}
function useLoading(): boolean {
  const [, force] = useState(0)
  useEffect(() => subscribe(() => force((n) => n + 1)), [])
  return getLoadingState()
}
import { getLoading } from './api'
function getLoadingState(): boolean { return getLoading() }
function useError(): string | null {
  const [, force] = useState(0)
  useEffect(() => subscribe(() => force((n) => n + 1)), [])
  return getError()
}

// ---------------------------------------------------------------------------
// Footer toggle (sidebar.footer.action item)
// ---------------------------------------------------------------------------
export function KanbanFooterButton() {
  const openNow = useOpen()
  return React.createElement('button', {
    className: 'hkb-btn',
    title: '打开看板',
    onClick: () => setOpen(!openNow),
  }, '📋', ' ', React.createElement('span', null, '看板'))
}

// ---------------------------------------------------------------------------
// Overlay root (shell.overlay item)
// ---------------------------------------------------------------------------
export function KanbanOverlay() {
  const openNow = useOpen()
  const snapshot = useSnapshot()
  useEffect(() => {
    // inject styles once
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=\'herness-kanban\']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'deepseek-herness-kanban'
      tag.dataset.pluginCss = 'herness-kanban'
      tag.textContent = BOARD_CSS
      document.head.appendChild(tag)
    }
  }, [])
  useEffect(() => {
    if (openNow) void refresh()
  }, [openNow])
  if (!openNow) return null
  return React.createElement('div', { className: 'hkb-root' },
    React.createElement(BoardHeader, { snapshot: snapshot }),
    React.createElement(BoardBody, { snapshot: snapshot }),
    React.createElement(ToastStack, null),
    React.createElement(TaskDrawerHost, null),
    React.createElement(DiffHost, null),
  )
}

// ---------------------------------------------------------------------------
// Header: board selector + actions
// ---------------------------------------------------------------------------
function BoardHeader({ snapshot }: { snapshot: Snapshot }) {
  const boardId = useSyncExternalStore(subscribeBoard, getCurrentBoardId, getCurrentBoardId)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const error = useError()
  const loading = useLoading()
  const board = snapshot.boards.find((b) => b.id === boardId) ?? null
  useEffect(() => {
    if (!boardId && snapshot.boards[0]) setCurrentBoardId(snapshot.boards[0].id)
  }, [snapshot.boards, boardId])
  const removeBoard = async () => {
    if (!board) return
    if (!confirm('删除项目「' + board.name + '」？\n将删除该项目下的所有任务卡片与执行记录，且不可恢复。\n（不会删除 Git 仓库本身）')) return
    setDeleting(true)
    try {
      await call('boards.delete', { boardId: board.id })
      setCurrentBoardId(null)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }
  return React.createElement('div', { className: 'hkb-header' },
    React.createElement('h1', null, '📋 看板'),
    React.createElement('select', {
      value: boardId ?? '',
      onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setCurrentBoardId(e.target.value || null),
    },
      snapshot.boards.length === 0 && React.createElement('option', { value: '' }, '（无看板）'),
      snapshot.boards.map((b) => React.createElement('option', { key: b.id, value: b.id }, b.name)),
    ),
    React.createElement('button', { className: 'hkb-btn', onClick: () => setAdding(true) }, '＋ 添加项目'),
    board && React.createElement('button', { className: 'hkb-btn danger', disabled: deleting, onClick: () => void removeBoard() }, deleting ? '删除中…' : '🗑 删除项目'),
    React.createElement('button', { className: 'hkb-btn', onClick: () => void refresh() }, loading ? '刷新中…' : '⟳ 刷新'),
    React.createElement('span', { className: 'hkb-muted' }, error ?? (isConnected() ? '' : '未连接')),
    React.createElement('span', { className: 'hkb-spacer' }, null),
    snapshot.queue > 0 && React.createElement('span', { className: 'hkb-badge' }, '排队 ' + snapshot.queue),
    React.createElement('button', { className: 'hkb-btn', onClick: () => setOpen(false) }, '✕ 关闭'),
    adding && React.createElement(NewBoardModal, { onClose: () => setAdding(false) }),
  )
}

// ---------------------------------------------------------------------------
// Board body: 4 columns
// ---------------------------------------------------------------------------
function BoardBody({ snapshot }: { snapshot: Snapshot }) {
  const boardId = useSyncExternalStore(subscribeBoard, getCurrentBoardId, getCurrentBoardId)
  const board = snapshot.boards.find((b) => b.id === boardId) ?? snapshot.boards[0]
  const [dragTask, setDragTask] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<ColumnId | null>(null)
  const [newTask, setNewTask] = useState(false)
  if (!board) {
    return React.createElement('div', { className: 'hkb-body' },
      React.createElement('div', { className: 'hkb-empty' }, '还没有看板。点击「＋ 添加项目」，输入名称和本地 Git 仓库路径。'),
    )
  }
  const tasks = snapshot.tasks.filter((t) => t.boardId === board.id)
  return React.createElement('div', { className: 'hkb-body' },
    COLUMNS.map((col) => {
      const colTasks = tasks.filter((t) => t.columnId === col)
      const running = Object.keys(snapshot.running).length
      const meta = COLUMN_META[col]
      return React.createElement('div', {
        key: col,
        className: 'hkb-col' + (overCol === col ? ' dragover' : ''),
        onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOverCol(col) },
        onDragLeave: () => setOverCol((c) => (c === col ? null : c)),
        onDrop: (e: React.DragEvent) => {
          e.preventDefault()
          setOverCol(null)
          const id = dragTask ?? e.dataTransfer.getData('text/plain')
          if (id) {
            const task = tasks.find((t) => t.id === id)
            if (col === 'doing') {
              // Dragging into Doing means "start working now" — but Req 2:
              // only todo cards can be dispatched.
              if (!task || task.columnId !== 'todo') {
                alert(task && task.columnId !== 'todo' ? '只有待办（todo）任务可以派发；当前状态 [' + task.columnId + ']' : '任务不存在: ' + id)
              } else {
                void call('exec.dispatch', { taskId: id }).catch((err) => alert(err instanceof Error ? err.message : String(err)))
              }
            } else if (task && task.columnId === 'review' && col !== 'todo' && col !== 'done') {
              // Req 2: review has exactly two exits — done (merge) / todo (reject or rollback).
              alert('审查中的任务只能「审查通过并合并」或「驳回到待办 / 回滚」')
            } else if (task && task.columnId === 'review') {
              // Route review exits through their lifecycle entry points.
              if (col === 'done') {
                alert('请使用「✅ 审查通过并合并」完成审查中的任务')
              } else {
                alert('请使用「↩ 驳回到待办」或「⏪ 回滚」将审查中的任务退回待办')
              }
            } else {
              void call('tasks.move', { taskId: id, columnId: col }).catch((err) => alert(err instanceof Error ? err.message : String(err)))
            }
          }
          setDragTask(null)
        },
      },
        React.createElement('div', { className: 'hkb-col-head' },
          React.createElement('span', { className: 'hkb-col-dot', style: { background: meta.color } }),
          meta.label,
          React.createElement('span', { className: 'hkb-col-count' }, colTasks.length),
        ),
        React.createElement('div', { className: 'hkb-cards' },
          colTasks.map((task) => React.createElement(CardView, { key: task.id, task: task, onDrag: setDragTask })),
          colTasks.length === 0 && React.createElement('div', { className: 'hkb-empty' }, '空'),
        ),
        col === 'todo' && React.createElement('button', { className: 'hkb-btn', style: { margin: 8 }, onClick: () => setNewTask(true) }, '＋ 新建任务'),
        col === 'doing' && running > 0 && React.createElement('div', { className: 'hkb-muted', style: { margin: 8 } }, '运行中 ' + running),
      )
    }),
    newTask && React.createElement(NewTaskModal, { boardId: board.id, onClose: () => setNewTask(false) }),
  )
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
function CardView({ task, onDrag }: { task: Task; onDrag: (id: string | null) => void }) {
  const badges = taskBadges(task)
  const last = task.attempts[task.attempts.length - 1]
  return React.createElement('div', {
    className: 'hkb-card',
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', task.id); onDrag(task.id) },
    onDragEnd: () => onDrag(null),
    onClick: () => selectTask(task.id),
  },
    React.createElement('div', { className: 'hkb-card-title' }, badges.join('') + ' ' + task.title),
    task.description && React.createElement('div', { className: 'hkb-card-desc' }, task.description.slice(0, 140)),
    React.createElement('div', { className: 'hkb-card-meta' },
      React.createElement('span', { className: 'hkb-badge priority' }, PRIORITY_BADGE[task.priority] + ' ' + task.priority),
      task.assignee && React.createElement('span', { className: 'hkb-badge' }, '👤 ' + task.assignee),
      task.schedule && React.createElement('span', { className: 'hkb-badge' }, '⏰ ' + (task.schedule.type === 'interval' ? task.schedule.interval + 'min' : task.schedule.dailyTime)),
      task.sessionId && React.createElement('span', { className: 'hkb-badge', title: 'session ' + task.sessionId }, '💬'),
      React.createElement('span', { className: 'hkb-spacer' }, null),
      task.id.slice(0, 12),
    ),
    last && last.status === 'running' && React.createElement('div', { className: 'hkb-progress' },
      React.createElement('div', { style: { width: (last.progress ?? 0) + '%' } }),
    ),
    last && (last.status === 'failed' || last.status === 'success') && React.createElement('div', { className: 'hkb-muted' },
      (last.status === 'failed' ? '⚠ ' : '✓ ') + (last.error ?? last.diffSummary ?? last.resultSummary ?? '').slice(0, 80),
    ),
  )
}
// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
function NewTaskModal({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('medium')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!title.trim()) return
    setBusy(true)
    try {
      await call('tasks.create', { boardId, title: title.trim(), description, priority })
      onClose()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
  return React.createElement('div', { className: 'hkb-modal-bg', onClick: onClose },
    React.createElement('div', { className: 'hkb-modal', onClick: (e: React.MouseEvent) => e.stopPropagation() },
      React.createElement('h3', null, '新建任务'),
      React.createElement('div', { className: 'hkb-field' },
        React.createElement('label', null, '标题'),
        React.createElement('input', { value: title, onChange: (e) => setTitle(e.target.value), placeholder: '做什么？', autoFocus: true, onKeyDown: (e) => e.key === 'Enter' && void submit() }),
      ),
      React.createElement('div', { className: 'hkb-field' },
        React.createElement('label', null, '描述（Markdown）'),
        React.createElement('textarea', { value: description, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value), placeholder: '目标、验收标准、上下文……' }),
      ),
      React.createElement('div', { className: 'hkb-field' },
        React.createElement('label', null, '优先级'),
        React.createElement('select', { value: priority, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setPriority(e.target.value) },
          ['low', 'medium', 'high', 'critical'].map((p) => React.createElement('option', { key: p, value: p }, PRIORITY_BADGE[p as keyof typeof PRIORITY_BADGE] + ' ' + p)),
        ),
      ),
      React.createElement('div', { className: 'hkb-row' },
        React.createElement('button', { className: 'hkb-btn primary', disabled: busy || !title.trim(), onClick: () => void submit() }, busy ? '创建中…' : '创建'),
        React.createElement('button', { className: 'hkb-btn', onClick: onClose }, '取消'),
      ),
    ),
  )
}

function NewBoardModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!name.trim() || !repoPath.trim()) return
    setBusy(true)
    try {
      await call('boards.create', { name: name.trim(), repoPath: repoPath.trim() })
      onClose()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
  return React.createElement('div', { className: 'hkb-modal-bg', onClick: onClose },
    React.createElement('div', { className: 'hkb-modal', onClick: (e: React.MouseEvent) => e.stopPropagation() },
      React.createElement('h3', null, '添加项目'),
      React.createElement('div', { className: 'hkb-field' },
        React.createElement('label', null, '名称'),
        React.createElement('input', { value: name, onChange: (e) => setName(e.target.value), placeholder: '例如 my-project', autoFocus: true }),
      ),
      React.createElement('div', { className: 'hkb-field' },
        React.createElement('label', null, 'Git 仓库本地路径'),
        React.createElement('input', { value: repoPath, onChange: (e) => setRepoPath(e.target.value), placeholder: '/absolute/path/to/repo' }),
        React.createElement('span', { className: 'hkb-muted' }, '不存在时自动 git init；已存在则自动识别主分支。'),
      ),
      React.createElement('div', { className: 'hkb-row' },
        React.createElement('button', { className: 'hkb-btn primary', disabled: busy || !name.trim() || !repoPath.trim(), onClick: () => void submit() }, busy ? '创建中…' : '创建看板'),
        React.createElement('button', { className: 'hkb-btn', onClick: onClose }, '取消'),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Task drawer
// ---------------------------------------------------------------------------
function TaskDrawerHost() {
  const selected = useSelected()
  const snapshot = useSnapshot()
  const task = selected ? snapshot.tasks.find((t) => t.id === selected) : null
  if (!selected) return null
  if (!task) {
    selectTask(null)
    return null
  }
  return React.createElement(TaskDrawer, { key: task.id, task: task })
}

function TaskDrawer({ task }: { task: Task }) {
  const [tab, setTab] = useState('detail')
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [comment, setComment] = useState('')
  const [blockReason, setBlockReason] = useState(task.blockReason ?? '')
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState<'reject' | 'rollback' | null>(null)
  const [appending, setAppending] = useState(false)
  const [catalog, setCatalog] = useState<DispatchCatalog | null>(null)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const last = task.attempts[task.attempts.length - 1]
  const running = last && (last.status === 'running' || last.status === 'pending')
  useEffect(() => {
    setTitle(task.title)
    setDescription(task.description)
    setBlockReason(task.blockReason ?? '')
  }, [task.id, task.title, task.description, task.blockReason])

  useEffect(() => {
    let alive = true
    rpc<DispatchCatalog>('dispatch.catalog')
      .then((catalog) => {
        if (!alive) return
        setCatalog(catalog)
        const d = catalog.defaults
        const nextProvider = d.provider ?? catalog.providers[0]?.id ?? ''
        const providerObj = catalog.providers.find((p) => p.id === nextProvider)
        const nextModel = d.model ?? providerObj?.models[0]?.id ?? ''
        const modelObj = providerObj?.models.find((m) => m.id === nextModel)
        setProvider(nextProvider)
        setModel(nextModel)
        setReasoningEffort(d.reasoningEffort ?? modelObj?.defaultEffort ?? modelObj?.reasoningEfforts?.[0]?.id ?? '')
        setCatalogError(null)
      })
      .catch((err) => setCatalogError(err instanceof Error ? err.message : String(err)))
    return () => { alive = false }
  }, [])
  const save = async () => {
    setBusy(true)
    try { await call('tasks.update', { taskId: task.id, title, description }) }
    catch (err) { alert(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const postComment = async () => {
    if (!comment.trim()) return
    await call('tasks.comment', { taskId: task.id, content: comment.trim(), author: 'user' })
    setComment('')
  }
  const remove = async () => {
    if (!confirm('删除任务 ' + task.title + ' ？')) return
    await call('tasks.delete', { taskId: task.id })
    selectTask(null)
  }
  const [discussing, setDiscussing] = useState(false)
  const [discussion, setDiscussion] = useState<{ taskId: string; sessionId: string } | null>(null)
  const startDiscussion = async () => {
    setDiscussing(true)
    try {
      const result = await rpc<{ taskId: string; sessionId: string }>('task.discuss', { taskId: task.id })
      setDiscussion(result)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setDiscussing(false)
    }
  }
  const discussionSessions = task.events.filter((ev) => ev.type === 'discussion_started').map((ev) => String(ev.data?.sessionId ?? '')).filter(Boolean)

  const providerObj = catalog?.providers.find((p) => p.id === provider)
  const modelObj = providerObj?.models.find((m) => m.id === model)
  const efforts = modelObj?.reasoningEfforts ?? []

  const changeModel = (nextModel: string) => {
    setModel(nextModel)
    const nextModelObj = providerObj?.models.find((m) => m.id === nextModel)
    setReasoningEffort(nextModelObj?.defaultEffort ?? nextModelObj?.reasoningEfforts?.[0]?.id ?? '')
  }

  const dispatch = async () => {
    setBusy(true)
    const runner: DispatchRunnerOptions = {
      mode: 'api',
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
    try {
      await call('exec.dispatch', { taskId: task.id, runner })
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const TABS = [
    ['detail', '详情'],
    ['diff', '📄 Diff 审查'],
    ['comments', '评论 (' + task.comments.length + ')'],
    ['events', '时间线'],
    ['runs', '执行 (' + task.attempts.length + ')'],
  ]
  return React.createElement('div', { className: 'hkb-overlay-bg', onClick: () => selectTask(null) },
    React.createElement('div', { className: 'hkb-drawer', onClick: (e: React.MouseEvent) => e.stopPropagation() },
      React.createElement('div', { className: 'hkb-drawer-head' },
        React.createElement('span', null, PRIORITY_BADGE[task.priority]),
        React.createElement('div', { style: { flex: 1, minWidth: 0 } },
          React.createElement('div', { className: 'hkb-muted' }, task.id),
          React.createElement('b', null, task.title),
        ),
        React.createElement('button', { className: 'hkb-btn', onClick: () => selectTask(null) }, '✕'),
      ),
      React.createElement('div', { className: 'hkb-tabs' },
        TABS.map(([key, label]) => React.createElement('button', { key: key, className: 'hkb-tab' + (tab === key ? ' active' : ''), onClick: () => setTab(key) }, label)),
      ),
      React.createElement('div', { className: 'hkb-drawer-body' },
        tab === 'detail' && React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'hkb-row' },
            running && React.createElement('button', { className: 'hkb-btn danger', onClick: () => void call('exec.stop', { taskId: task.id }) }, '⏹ 停止运行'),
            // Req 2: only todo cards can be dispatched.
            task.columnId === 'todo' && !running && React.createElement('button', { className: 'hkb-btn primary', disabled: busy || !provider || !model, onClick: () => void dispatch() }, busy ? '派发中…' : '▶ 派发（API）'),
            task.columnId === 'review' && React.createElement('button', { className: 'hkb-btn success', onClick: () => void call('review.merge', { taskId: task.id, author: 'user' }) }, '✅ 审查通过并合并'),
            task.columnId === 'review' && React.createElement('button', { className: 'hkb-btn danger', title: '驳回到待办，保留 main 上的合并代码，可继续补充内容后重新派发', onClick: () => setRejecting('reject') }, '↩ 驳回到待办'),
            task.columnId === 'review' && React.createElement('button', { className: 'hkb-btn danger', title: '撤销 main 上的合并提交并退回待办', onClick: () => setRejecting('rollback') }, '⏪ 回滚'),
            React.createElement('button', { className: 'hkb-btn', onClick: () => setAppending(true) }, '✏️ 补充细节'),
            React.createElement('button', { className: 'hkb-btn', onClick: () => void remove() }, '🗑 删除'),
            React.createElement('span', { className: 'hkb-spacer' }, null),
          ),
          // Req 3: refine requirements in a task-scoped conversation (todo stage).
          task.columnId === 'todo' && !running && React.createElement('div', { className: 'hkb-row' },
            React.createElement('button', { className: 'hkb-btn', disabled: discussing, onClick: () => void startDiscussion() }, discussing ? '开启中…' : '💬 细化需求（任务对话）'),
            (discussion || discussionSessions.length > 0) && React.createElement('span', { className: 'hkb-muted', style: { fontSize: 12 } },
              (discussion ? '已创建会话 ' + discussion.sessionId : '') +
              (discussion ? '；' : '') +
              (discussionSessions.length > 0 ? '历史会话: ' + discussionSessions.join(', ') : '') +
              ' — 在左侧工作区中找到该会话继续对话，上下文仅包含本任务',
            ),
          ),
          rejecting && React.createElement(RejectPanel, { task: task, mode: rejecting, onClose: () => setRejecting(null) }),
          appending && React.createElement(AppendDetailModal, { task: task, onClose: () => setAppending(false) }),
          task.columnId === 'todo' && React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'hkb-field' },
              React.createElement('label', null, '模式'),
              React.createElement('select', { value: 'api', disabled: true },
                React.createElement('option', { value: 'api' }, 'API'),
              ),
            ),
            catalogError && React.createElement('div', { className: 'hkb-muted', style: { color: '#f87171' } }, catalogError),
            React.createElement('div', { className: 'hkb-field' },
              React.createElement('label', null, '模型'),
              React.createElement('select', {
                value: model,
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => changeModel(e.target.value),
              },
                (providerObj?.models ?? []).map((m) => React.createElement('option', { key: m.id, value: m.id }, m.name)),
                (providerObj?.models ?? []).length === 0 && React.createElement('option', { value: '' }, '（无可用模型）'),
              ),
            ),
            React.createElement('div', { className: 'hkb-field' },
              React.createElement('label', null, '思考强度'),
              React.createElement('select', {
                value: reasoningEffort,
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setReasoningEffort(e.target.value),
              },
                efforts.map((e) => React.createElement('option', { key: e.id, value: e.id }, e.name)),
                efforts.length === 0 && React.createElement('option', { value: '' }, '（跟随模型默认）'),
              ),
            ),
          ),
          React.createElement('div', { className: 'hkb-field' },
            React.createElement('label', null, '标题'),
            React.createElement('input', { value: title, onChange: (e) => setTitle(e.target.value) }),
          ),
          React.createElement('div', { className: 'hkb-field' },
            React.createElement('label', null, '描述（Markdown，持续沉淀上下文）'),
            React.createElement('textarea', { value: description, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value), style: { minHeight: 140 } }),
          ),
          React.createElement('div', { className: 'hkb-row' },
            React.createElement('button', { className: 'hkb-btn primary', disabled: busy, onClick: () => void save() }, '保存'),
            React.createElement('label', { className: 'hkb-badge' },
              React.createElement('input', { type: 'checkbox', checked: !!task.isBlocked, onChange: (e) => void call('tasks.update', { taskId: task.id, isBlocked: e.target.checked, blockReason: e.target.checked ? blockReason : undefined }) }),
              ' 🚫 阻塞'),
            ),
            task.isBlocked && React.createElement('input', { value: blockReason, placeholder: '阻塞原因', onChange: (e) => setBlockReason(e.target.value), onBlur: () => void call('tasks.update', { taskId: task.id, blockReason }) }),
          task.sessionId && React.createElement('div', { className: 'hkb-muted' }, '来源会话: ' + task.sessionId + (task.threadId ? ' · 线程: ' + task.threadId : '')),
        ),
        tab === 'diff' && React.createElement(DiffPanel, { task: task }),
        tab === 'comments' && React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'hkb-row' },
            React.createElement('input', { style: { flex: 1 }, value: comment, placeholder: '写下讨论、决策或审查意见…', onChange: (e) => setComment(e.target.value), onKeyDown: (e) => e.key === 'Enter' && void postComment() }),
            React.createElement('button', { className: 'hkb-btn primary', onClick: () => void postComment() }, '评论'),
          ),
          task.comments.slice().reverse().map((c) => React.createElement('div', { key: c.id, className: 'hkb-comment' },
            React.createElement('div', { className: 'hkb-comment-head' },
              React.createElement('b', null, c.author),
              React.createElement('span', null, fmtTime(c.createdAt)),
              c.filePath && React.createElement('span', null, c.filePath + (c.lineNumber ? ':' + c.lineNumber : '')),
            ),
            React.createElement('div', null, c.content),
          )),
          task.comments.length === 0 && React.createElement('div', { className: 'hkb-empty' }, '暂无评论'),
        ),
        tab === 'events' && React.createElement('div', null,
          task.events.slice().reverse().map((ev) => React.createElement('div', { key: ev.id, className: 'hkb-event' },
            React.createElement('span', { className: 'hkb-event-type' }, ev.type),
            React.createElement('span', null, fmtTime(ev.timestamp)),
            React.createElement('span', null, summarizeEventData(ev.data)),
          )),
          task.events.length === 0 && React.createElement('div', { className: 'hkb-empty' }, '暂无事件'),
        ),
        tab === 'runs' && React.createElement(RunsPanel, { task: task }),
      ),
    ),
  )
}

function summarizeEventData(data: Record<string, unknown>): string {
  const interesting: string[] = []
  for (const key of ['from', 'to', 'summary', 'error', 'commit', 'branch', 'actor', 'author', 'reason']) {
    const value = data[key]
    if (typeof value === 'string' && value) interesting.push(key + '=' + value.slice(0, 60))
  }
  return interesting.join(' ')
}

function RejectPanel({ task, mode, onClose }: { task: Task; mode: 'reject' | 'rollback'; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      // Optional: append new requirements to the card description first, so a
      // rejected card carries the review's follow-up content straight into todo.
      if (extra.trim()) {
        await call('tasks.appendDetail', { taskId: task.id, content: extra.trim(), author: 'user' })
      }
      if (mode === 'rollback') {
        await call('review.revert', { taskId: task.id, reason: reason.trim() || '未说明原因', author: 'user' })
      } else {
        await call('review.reject', { taskId: task.id, reason: reason.trim() || '未说明原因', author: 'user' })
      }
      onClose()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
  const rollback = mode === 'rollback'
  return React.createElement('div', { className: 'hkb-modal-bg', onClick: onClose },
    React.createElement('div', { className: 'hkb-modal', onClick: (e: React.MouseEvent) => e.stopPropagation() },
      React.createElement('h3', null, rollback ? '回滚并退回待办' : '驳回到待办'),
      React.createElement('div', { className: 'hkb-field' },
        React.createElement('label', null, '审查意见（记录在卡片上）'),
        React.createElement('textarea', { value: reason, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value), autoFocus: true }),
      ),
      React.createElement('div', { className: 'hkb-field' },
        React.createElement('label', null, '补充的新要求（可选，直接追加到卡片描述）'),
        React.createElement('textarea', { value: extra, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setExtra(e.target.value), placeholder: '例如：需要补充支持 X 场景……' }),
      ),
      React.createElement('div', { className: 'hkb-row' },
        React.createElement('button', { className: 'hkb-btn danger', disabled: busy, onClick: () => void submit() }, busy ? (rollback ? '回滚中…' : '处理中…') : (rollback ? '⏪ 确认回滚' : '↩ 确认驳回')),
        React.createElement('button', { className: 'hkb-btn', onClick: onClose }, '取消'),
      ),
    ),
  )
}

/** ✏️ 补充细节 — append a dated section to the card description without leaving the board. */
function AppendDetailModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!content.trim()) return
    setBusy(true)
    try {
      await call('tasks.appendDetail', { taskId: task.id, content: content.trim(), author: 'user' })
      onClose()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
  return React.createElement('div', { className: 'hkb-modal-bg', onClick: onClose },
    React.createElement('div', { className: 'hkb-modal', onClick: (e: React.MouseEvent) => e.stopPropagation() },
      React.createElement('h3', null, '✏️ 补充细节'),
      React.createElement('div', { className: 'hkb-field' },
        React.createElement('label', null, '补充内容（Markdown，追加到卡片描述，不覆盖原有内容）'),
        React.createElement('textarea', { value: content, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value), autoFocus: true, style: { minHeight: 120 }, placeholder: '例如：补充验收标准、新的需求细节……' }),
      ),
      React.createElement('div', { className: 'hkb-row' },
        React.createElement('button', { className: 'hkb-btn primary', disabled: busy || !content.trim(), onClick: () => void submit() }, busy ? '追加中…' : '追加到描述'),
        React.createElement('button', { className: 'hkb-btn', onClick: onClose }, '取消'),
      ),
    ),
  )
}

function RunsPanel({ task }: { task: Task }) {
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    task.attempts.slice().reverse().map((attempt) => React.createElement('div', { key: attempt.id, className: 'hkb-comment' },
      React.createElement('div', { className: 'hkb-comment-head' },
        React.createElement('b', null, attempt.status),
        React.createElement('span', null, fmtTime(attempt.startedAt)),
        attempt.branchName && React.createElement('span', null, '🌿 ' + attempt.branchName),
        attempt.worktreePath && React.createElement('span', null, attempt.worktreePath),
      ),
      attempt.status === 'running' && React.createElement('div', { className: 'hkb-progress' },
        React.createElement('div', { style: { width: (attempt.progress ?? 0) + '%' } }),
      ),
      attempt.error && React.createElement('div', { className: 'hkb-muted' }, '⚠ ' + attempt.error),
      attempt.diffSummary && React.createElement('div', { className: 'hkb-muted' }, '改动: ' + attempt.diffSummary),
      attempt.progressLogs.length > 0 && React.createElement('div', { className: 'hkb-console' }, attempt.progressLogs.slice(-50).join('\n')),
    )),
    task.attempts.length === 0 && React.createElement('div', { className: 'hkb-empty' }, '还没有执行记录'),
  )
}

// ---------------------------------------------------------------------------
// Diff review
// ---------------------------------------------------------------------------
function DiffHost() {
  return null
}

function DiffPanel({ task }: { task: Task }) {
  const [summary, setSummary] = useState<DiffSummary | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        const diff = await rpc<DiffSummary>('review.diff', { taskId: task.id })
        if (!cancelled) { setSummary(diff); setActive(diff.files[0]?.path ?? null) }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => { cancelled = true }
  }, [task.id])
  if (busy) return React.createElement('div', { className: 'hkb-empty' }, '生成 Diff 中…')
  if (error) return React.createElement('div', { className: 'hkb-empty' }, '⚠ ' + error)
  if (!summary || summary.files.length === 0) return React.createElement('div', { className: 'hkb-empty' }, '没有代码改动。')
  const file = summary.files.find((f) => f.path === active) ?? summary.files[0]
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    React.createElement('div', { className: 'hkb-row' },
      React.createElement('span', { className: 'hkb-badge' }, summary.filesChanged + ' 文件'),
      React.createElement('span', { className: 'hkb-badge', style: { color: '#86efac' } }, '+' + summary.additions),
      React.createElement('span', { className: 'hkb-badge', style: { color: '#fca5a5' } }, '-' + summary.deletions),
      React.createElement('span', { className: 'hkb-spacer' }, null),
      React.createElement('button', { className: 'hkb-btn success', onClick: () => void call('review.merge', { taskId: task.id, author: 'user' }) }, '✅ 审查通过并合并'),
      React.createElement('button', { className: 'hkb-btn danger', title: '驳回到待办，保留 main 上的合并代码', onClick: () => { const reason = prompt('驳回原因（驳回到待办，不回滚代码）：'); if (reason !== null) void call('review.reject', { taskId: task.id, reason, author: 'user' }) } }, '↩ 驳回到待办'),
      React.createElement('button', { className: 'hkb-btn danger', title: '撤销 main 上的合并提交并退回待办', onClick: () => { const reason = prompt('回滚原因（撤销合并并退回待办）：'); if (reason !== null) void call('review.revert', { taskId: task.id, reason, author: 'user' }) } }, '⏪ 回滚'),
    ),
    React.createElement('div', { style: { display: 'flex', gap: 10, minHeight: 0 } },
      React.createElement('div', { style: { width: 230, flexShrink: 0, maxHeight: 46 * 6, overflowY: 'auto' } },
        summary.files.map((f) => React.createElement('div', { key: f.path, className: 'hkb-diff-file' + (f.path === file.path ? ' active' : ''), onClick: () => setActive(f.path) },
          React.createElement('span', null, f.kind === 'added' ? 'A' : f.kind === 'deleted' ? 'D' : f.kind === 'renamed' ? 'R' : 'M'),
          React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.path),
        )),
      ),
      React.createElement('div', { className: 'hkb-diff-body', style: { flex: 1 } },
        renderDiffLines(file.diff).map((line, index) => React.createElement('div', { key: index, className: 'hkb-diff-line ' + line.kind }, line.text || ' ')),
      ),
    ),
    React.createElement('div', { className: 'hkb-muted' }, '双击任意代码行可为该文件添加逐行审查评论（CR-05）'),
  )
}

function renderDiffLines(diff: string): Array<{ kind: string; text: string }> {
  return diff.split('\n').map((line) => {
    let kind = 'plain'
    if (line.startsWith('+++') || line.startsWith('---')) kind = 'meta'
    else if (line.startsWith('@@')) kind = 'hunk'
    else if (line.startsWith('+')) kind = 'add'
    else if (line.startsWith('-')) kind = 'del'
    else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename')) kind = 'meta'
    return { kind, text: line }
  })
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function ToastStack() {
  const toasts = useToasts()
  return React.createElement('div', { className: 'hkb-toasts' },
    toasts.map((t) => React.createElement('div', { key: t.id, className: 'hkb-toast ' + t.kind, onClick: () => dismissToast(t.id) },
      React.createElement('b', null, t.title),
      React.createElement('div', null, t.message),
    )),
  )
}

