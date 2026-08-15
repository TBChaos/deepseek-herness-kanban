/**
 * SchedulerService tests with a fake agent runner (no real DSH needed).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitService } from '../src/git.js'
import { KanbanStore, MemoryBackend } from '../src/store.js'
import { SchedulerService, type AgentRunner, type DispatchOptions, type RunningSession, type SessionOutcome } from '../src/scheduler.js'

function fakeRunner(outcome: SessionOutcome): AgentRunner {
  return {
    spawn: async (_options: DispatchOptions): Promise<RunningSession> => ({
      sessionId: 'fake-session',
      wait: async () => outcome,
      stop: async () => {},
    }),
  }
}

describe('SchedulerService', () => {
  it('dispatches into an isolated worktree and settles success → review (AE-02, AE-04)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hkb-sched-'))
    const git = new GitService()
    await git.ensureRepo(dir, 'main')
    writeFileSync(join(dir, 'base.txt'), 'base\n')
    await git.commitAll(dir, 'chore: base')

    const store = new KanbanStore(new MemoryBackend())
    const board = await store.createBoard({ name: 'demo', repoPath: dir }, 'main')
    const task = await store.createTask({ boardId: board.id, title: 'implement thing' })
    const scheduler = new SchedulerService(store, git, fakeRunner({ status: 'success', summary: 'done' }))

    const attempt = await scheduler.dispatch(task.id)
    assert.equal(attempt.status, 'running')
    // wait for settle
    await waitFor(() => store.getTask(task.id).columnId === 'review', 5000)
    const settled = store.getTask(task.id)
    assert.equal(settled.columnId, 'review')
    assert.equal(settled.attempts[0]?.status, 'success')
    assert.ok(settled.attempts[0]?.diffSummary)
    assert.equal(await git.branchExists(dir, 'herness-task-' + task.id), true)
    await scheduler.dispose()
  })

  it('settles failure → todo with error summary (AE-04)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hkb-sched-'))
    const git = new GitService()
    await git.ensureRepo(dir, 'main')
    writeFileSync(join(dir, 'base.txt'), 'x\n')
    await git.commitAll(dir, 'chore: base')

    const store = new KanbanStore(new MemoryBackend())
    const board = await store.createBoard({ name: 'demo', repoPath: dir }, 'main')
    const task = await store.createTask({ boardId: board.id, title: 'broken' })
    const scheduler = new SchedulerService(store, git, fakeRunner({ status: 'failed', error: 'syntax error' }))

    await scheduler.dispatch(task.id)
    await waitFor(() => {
      const t = store.getTask(task.id)
      return t.columnId === 'todo' && t.attempts[0]?.status === 'failed'
    }, 5000)
    const t = store.getTask(task.id)
    assert.equal(t.attempts[0]?.error, 'syntax error')
    await scheduler.dispose()
  })

  it('queues beyond maxConcurrent and pumps when slots free (NF-06)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hkb-sched-'))
    const git = new GitService()
    await git.ensureRepo(dir, 'main')
    writeFileSync(join(dir, 'base.txt'), 'x\n')
    await git.commitAll(dir, 'chore: base')

    const store = new KanbanStore(new MemoryBackend())
    const board = await store.createBoard({ name: 'demo', repoPath: dir }, 'main')
    const gates: Array<() => void> = []
    const runner: AgentRunner = {
      spawn: async () => ({
        sessionId: 's',
        wait: () => new Promise<SessionOutcome>((resolve) => gates.push(() => resolve({ status: 'success' }))),
        stop: async () => {},
      }),
    }
    const scheduler = new SchedulerService(store, git, runner, { maxConcurrent: 1 })
    const t1 = await store.createTask({ boardId: board.id, title: 'one' })
    const t2 = await store.createTask({ boardId: board.id, title: 'two' })
    await scheduler.dispatch(t1.id)
    await waitFor(() => scheduler.activeCount === 1, 5000)
    const queued = await scheduler.dispatch(t2.id)
    assert.equal(scheduler.pendingCount, 1)
    assert.ok(queued)
    gates.shift()?.()
    await waitFor(() => scheduler.pendingCount === 0 && scheduler.activeCount === 1, 5000)
    gates.shift()?.()
    await waitFor(() => scheduler.activeCount === 0, 5000)
    assert.equal(store.getTask(t1.id).columnId, 'review')
    assert.equal(store.getTask(t2.id).columnId, 'review')
    await scheduler.dispose()
  })
})

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('waitFor timed out')
}

