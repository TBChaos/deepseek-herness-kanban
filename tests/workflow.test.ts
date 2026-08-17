/**
 * Req 2 workflow tests: the 4-column state machine.
 *
 * - Only todo cards can be dispatched (scheduler guard).
 * - Manual column moves are limited (todo↔done, doing→todo); review has
 *   exactly two exits — merge (→done) and revert (→todo).
 * - merge/revert require the card to be in review.
 * - A full lifecycle with a real repo: dispatch → review → merge → done,
 *   and dispatch → review → revert → todo (unmerged branch must not break).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitService } from '../src/git.js'
import { KanbanStore, MemoryBackend } from '../src/store.js'
import { SchedulerService, type AgentRunner, type DispatchOptions, type RunningSession, type SessionOutcome } from '../src/scheduler.js'
import { KanbanService } from '../src/service.js'

function gitRun(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function gitShow(path: string, cwd: string): string {
  return execFileSync('git', ['show', 'HEAD:' + path], { cwd, encoding: 'utf8' }).trim()
}

function fakeRunner(outcome: SessionOutcome = { status: 'success', summary: 'ok' }): AgentRunner {
  return {
    spawn: async (_options: DispatchOptions): Promise<RunningSession> => ({
      sessionId: 'fake-session',
      wait: async () => outcome,
      stop: async () => {},
    }),
  }
}

async function setupRepo(): Promise<{ dir: string; git: GitService; store: KanbanStore; board: import('../src/types.js').Board }> {
  const dir = mkdtempSync(join(tmpdir(), 'hkb-wf-'))
  const git = new GitService()
  await git.ensureRepo(dir, 'main')
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  await git.commitAll(dir, 'chore: base')
  const store = new KanbanStore(new MemoryBackend())
  const board = await store.createBoard({ name: 'demo', repoPath: dir }, 'main')
  return { dir, git, store, board }
}

function makeService(store: KanbanStore, git: GitService, runner: AgentRunner): { scheduler: SchedulerService; service: KanbanService } {
  const scheduler = new SchedulerService(store, git, runner)
  const service = new KanbanService({
    store,
    git,
    scheduler,
    complete: async () => { throw new Error('complete is not used in these tests') },
  })
  return { scheduler, service }
}

describe('workflow state machine (Req 2)', () => {
  it('rejects dispatch of non-todo cards', async () => {
    const { git, store, board } = await setupRepo()
    const { scheduler, service } = makeService(store, git, fakeRunner())
    const task = await store.createTask({ boardId: board.id, title: 't' })

    await store.moveTask(task.id, 'doing')
    await assert.rejects(service.dispatch(task.id), /only todo tasks can be dispatched/)
    await store.moveTask(task.id, 'review')
    await assert.rejects(service.dispatch(task.id), /only todo tasks can be dispatched/)
    await store.moveTask(task.id, 'done')
    await assert.rejects(service.dispatch(task.id), /only todo tasks can be dispatched/)

    const back = await store.moveTask(task.id, 'todo')
    const attempt = await service.dispatch(back.id)
    assert.equal(attempt.status, 'running')
    await scheduler.dispose()
  })

  it('allows only todo→done and done→todo as free manual moves', async () => {
    const { git, store, board } = await setupRepo()
    const { service } = makeService(store, git, fakeRunner())
    const task = await store.createTask({ boardId: board.id, title: 't' })

    // todo → doing / review are blocked (they have their own entry points)
    await assert.rejects(service.moveTask(task.id, 'doing'), /派发/)
    await assert.rejects(service.moveTask(task.id, 'review'), /自动进入/)

    // todo ↔ done is a free manual close/reopen
    const done = await service.moveTask(task.id, 'done')
    assert.equal(done.columnId, 'done')
    const reopened = await service.moveTask(task.id, 'todo')
    assert.equal(reopened.columnId, 'todo')

    // doing → todo (abandon) is allowed; doing → review/done are not
    await store.moveTask(task.id, 'doing')
    assert.equal((await service.moveTask(task.id, 'todo')).columnId, 'todo')
    await store.moveTask(task.id, 'doing')
    await assert.rejects(service.moveTask(task.id, 'review'), /自动进入/)
    await assert.rejects(service.moveTask(task.id, 'done'), /审查流程/)

    // review: exactly two exits — merge (→done) and revert (→todo)
    await store.moveTask(task.id, 'review')
    await assert.rejects(service.moveTask(task.id, 'done'), /合并/)
    await assert.rejects(service.moveTask(task.id, 'todo'), /驳回/)
    await assert.rejects(service.moveTask(task.id, 'doing'), /派发/)

    // done: reopening is allowed; nothing else
    await store.moveTask(task.id, 'done')
    await assert.rejects(service.moveTask(task.id, 'doing'), /返工/)
    await assert.rejects(service.moveTask(task.id, 'review'), /返工/)
    assert.equal((await service.moveTask(task.id, 'todo')).columnId, 'todo')
  })

  it('merge/reject/revert require the card to be in review', async () => {
    const { git, store, board } = await setupRepo()
    const { service } = makeService(store, git, fakeRunner())
    const task = await store.createTask({ boardId: board.id, title: 't' })

    await assert.rejects(service.mergeTask(task.id), /只有审查中/)
    await assert.rejects(service.rejectTask(task.id, 'nope'), /只有审查中/)
    await assert.rejects(service.revertTask(task.id, 'nope'), /只有审查中/)

    const done = await store.moveTask(task.id, 'done')
    await assert.rejects(service.mergeTask(done.id), /只有审查中/)
    await assert.rejects(service.rejectTask(done.id, 'nope'), /只有审查中/)
    await assert.rejects(service.revertTask(done.id, 'nope'), /只有审查中/)
  })

  it('full lifecycle: dispatch → review → merge → done', async () => {
    const { dir, git, store, board } = await setupRepo()
    const task = await store.createTask({ boardId: board.id, title: 'm' })
    const { scheduler, service } = makeService(store, git, fakeRunner())

    await service.dispatch(task.id)
    await waitFor(() => store.getTask(task.id).columnId === 'review', 5000)

    const merged = await service.mergeTask(task.id)
    assert.equal(merged.task.columnId, 'done')
    assert.ok(merged.commit)
    // worktree + branch destroyed on merge
    assert.equal(await git.branchExists(dir, 'herness-task-' + task.id), false)
    await scheduler.dispose()
  })

  it('full lifecycle: dispatch → review → revert → todo (unmerged branch)', async () => {
    const { dir, git, store, board } = await setupRepo()
    const task = await store.createTask({ boardId: board.id, title: 'r' })
    const { scheduler, service } = makeService(store, git, fakeRunner())

    await service.dispatch(task.id)
    await waitFor(() => store.getTask(task.id).columnId === 'review', 5000)

    // the branch was never merged into main — reverting must skip `git revert`
    const reverted = await service.revertTask(task.id, '需要修改')
    assert.equal(reverted.task.columnId, 'todo')
    assert.equal(reverted.commit, undefined)
    assert.equal(await git.branchExists(dir, 'herness-task-' + task.id), false)
    const card = store.getTask(task.id)
    assert.ok(card.comments.some((c) => c.content.includes('需要修改')), 'review notes recorded on the card')
    await scheduler.dispose()
  })

  it('reject returns the card to todo without touching main; revert undoes a previous merge', async () => {
    const { dir, git, store, board } = await setupRepo()
    const task = await store.createTask({ boardId: board.id, title: 'rr' })
    const { scheduler, service } = makeService(store, git, fakeRunner())

    // first round: dispatch → review, add real content on the task branch and
    // merge it into main manually (simulating an approved + merged task)
    await service.dispatch(task.id)
    await waitFor(() => store.getTask(task.id).columnId === 'review', 5000)
    const attempt = store.getTask(task.id).attempts[store.getTask(task.id).attempts.length - 1]
    writeFileSync(join(attempt.worktreePath!, 'feature.txt'), 'feature\n')
    await git.commitAll(attempt.worktreePath!, 'feat(' + task.id + '): feature')
    await gitRun(dir, ['checkout', board.mainBranch])
    await gitRun(dir, ['merge', '--no-ff', 'herness-task-' + task.id, '-m', 'Merge task ' + task.id + ' (herness-task-' + task.id + ')'])

    // reject (no rollback): card → todo, worktree gone, main keeps the merge
    const rejected = await service.rejectTask(task.id, '先补充细节')
    assert.equal(rejected.task.columnId, 'todo')
    assert.equal(rejected.commit, undefined)
    assert.equal(await git.branchExists(dir, 'herness-task-' + task.id), false)
    assert.ok(store.getTask(task.id).comments.some((c) => c.content.includes('先补充细节')))
    assert.ok(gitShow('feature.txt', dir).includes('feature'), 'reject keeps the merged content on main')

    // second round: dispatch → review again; revert now undoes the old merge
    await service.dispatch(task.id)
    await waitFor(() => store.getTask(task.id).columnId === 'review', 5000)
    const reverted = await service.revertTask(task.id, '撤销')
    assert.equal(reverted.task.columnId, 'todo')
    assert.ok(reverted.commit, 'a revert commit was created')
    assert.throws(() => gitShow('feature.txt', dir), /does not exist|pathspec|fatal/, 'revert removes the merged content from main')
    await scheduler.dispose()
  })

  it('deleteBoard refuses while a task is running and then deletes cleanly', async () => {
    const { git, store, board } = await setupRepo()
    const task = await store.createTask({ boardId: board.id, title: 't' })
    const { scheduler, service } = makeService(store, git, fakeRunner({ status: 'success', summary: 'ok' }))

    // running attempt → deletion refused
    const attempt = await service.dispatch(task.id)
    assert.equal(attempt.status, 'running')
    await assert.rejects(service.deleteBoard(board.id), /仍有任务在运行/)

    // wait for settle (success → review), then deletion is allowed and wipes the board
    await waitFor(() => store.getTask(task.id).columnId === 'review', 5000)
    await service.deleteBoard(board.id)
    assert.equal(store.listBoards().length, 0)
    assert.equal(store.listTasks().length, 0)
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
