import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KanbanStore, MemoryBackend } from '../src/store.js'
import { createParsedTasks, normalizeParseResult } from '../src/parse.js'

describe('KanbanStore', () => {
  it('creates boards with the default 4 columns', async () => {
    const store = new KanbanStore(new MemoryBackend())
    const board = await store.createBoard({ name: 'demo', repoPath: '/tmp/demo' }, 'main')
    assert.equal(board.columns.length, 4)
    assert.deepEqual(board.columns.map((c) => c.id), ['todo', 'doing', 'review', 'done'])
    assert.equal(store.getBoard(board.id).mainBranch, 'main')
  })

  it('creates tasks bound to their session (TM-09) and records events', async () => {
    const store = new KanbanStore(new MemoryBackend())
    const board = await store.createBoard({ name: 'demo', repoPath: '/tmp/demo' })
    const task = await store.createTask({
      boardId: board.id,
      title: 'fix auth bug',
      description: 'token refresh loop',
      priority: 'high',
      sessionId: 'sess-1',
      threadId: 'thread-9',
    })
    assert.equal(task.sessionId, 'sess-1')
    assert.equal(task.threadId, 'thread-9')
    assert.equal(task.columnId, 'todo')
    assert.equal(task.events[0]?.type, 'created')
  })

  it('moves columns with events and completes tasks', async () => {
    const store = new KanbanStore(new MemoryBackend())
    const board = await store.createBoard({ name: 'demo', repoPath: '/tmp/demo' })
    const task = await store.createTask({ boardId: board.id, title: 't1' })
    const moved = await store.moveTask(task.id, 'doing')
    assert.equal(moved.columnId, 'doing')
    assert.equal(moved.events.some((e) => e.type === 'column_changed'), true)
    const done = await store.moveTask(task.id, 'done')
    assert.ok(done.completedAt)
  })

  it('accumulates comments and description versions (TM-10)', async () => {
    const store = new KanbanStore(new MemoryBackend())
    const board = await store.createBoard({ name: 'demo', repoPath: '/tmp/demo' })
    const task = await store.createTask({ boardId: board.id, title: 't1', description: 'v1' })
    await store.addComment(task.id, 'alice', 'first note')
    await store.addComment(task.id, 'bob', 'second note', { filePath: 'src/a.ts', lineNumber: 12 })
    const updated = await store.updateTask(task.id, { description: 'v2' }, 'agent')
    assert.equal(updated.comments.length, 2)
    assert.equal(updated.comments[1]?.lineNumber, 12)
    assert.equal(updated.description, 'v2')
    assert.equal(updated.events.some((e) => e.type === 'description_updated'), true)
    assert.equal(updated.events.some((e) => e.type === 'commented'), true)
  })

  it('tracks attempts and settles success → review, failure → todo (AE-04)', async () => {
    const store = new KanbanStore(new MemoryBackend())
    const board = await store.createBoard({ name: 'demo', repoPath: '/tmp/demo' })
    const task = await store.createTask({ boardId: board.id, title: 't1' })
    const attempt = await store.beginAttempt(task, 'sess', '/tmp/demo-task', 'herness-task-' + task.id)
    assert.equal(attempt.status, 'running')
    const success = await store.settleAttempt(task.id, attempt.id, { status: 'success', diffSummary: '2 files' })
    assert.equal(success.columnId, 'review')
    const attempt2 = await store.beginAttempt(success, 'sess2')
    const failed = await store.settleAttempt(task.id, attempt2.id, { status: 'failed', error: 'boom' })
    assert.equal(failed.columnId, 'todo')
    assert.equal(failed.attempts.length, 2)
  })

  it('deletes a board with its tasks', async () => {
    const store = new KanbanStore(new MemoryBackend())
    const board = await store.createBoard({ name: 'demo', repoPath: '/tmp/demo' })
    await store.createTask({ boardId: board.id, title: 't1' })
    await store.deleteBoard(board.id)
    assert.equal(store.listBoards().length, 0)
    assert.equal(store.listTasks().length, 0)
  })
})

describe('parse (DC-01..DC-04)', () => {
  it('normalizes model JSON', () => {
    const raw = JSON.stringify({
      tasks: [
        { title: 'Add login', description: 'oauth flow', priority: 'high', dependsOn: null },
        { title: '  ', description: 'skipped', priority: 'low', dependsOn: 0 },
        { title: 'Add tests', description: 'unit tests', priority: 'medium', dependsOn: 0 },
      ],
    })
    const parsed = normalizeParseResult(raw)
    assert.equal(parsed.length, 2)
    assert.equal(parsed[0]?.title, 'Add login')
    assert.equal(parsed[1]?.dependsOn, 0)
  })

  it('rejects invalid output', () => {
    assert.throws(() => normalizeParseResult('not json at all'))
    assert.throws(() => normalizeParseResult(JSON.stringify({ tasks: [] })))
  })

  it('batch-creates with dedupe (DC-03) and parent links (DC-04)', async () => {
    const store = new KanbanStore(new MemoryBackend())
    const board = await store.createBoard({ name: 'demo', repoPath: '/tmp/demo' })
    await store.createTask({ boardId: board.id, title: 'Add login' })
    const result = await createParsedTasks(store, {
      boardId: board.id,
      sessionId: 'sess-1',
      linkDependencies: true,
      tasks: [
        { title: 'Add login', description: 'dup', priority: 'high', dependsOn: null },
        { title: 'Add login page', description: 'new', priority: 'medium', dependsOn: null },
        { title: 'Test login page', description: 'child', priority: 'low', dependsOn: 1 },
      ],
    })
    assert.equal(result.skippedDuplicates, 1)
    assert.equal(result.created.length, 2)
    assert.equal(result.dependencyLinked, 1)
    const child = result.created[1]
    assert.ok(child)
    assert.equal(child.parentTaskId, result.created[0]?.id)
    assert.equal(child.sessionId, 'sess-1')
  })
})

