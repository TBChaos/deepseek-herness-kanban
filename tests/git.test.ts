/**
 * GitService integration tests against a real temporary repository.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitService } from '../src/git.js'
import type { Board, Task } from '../src/types.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hkb-git-'))
  const git = new GitService()
  return { dir, git }
}

function boardFor(repoPath: string): Board {
  return { id: 'board-1', name: 'test', repoPath, mainBranch: 'main', columns: [], createdAt: 1, updatedAt: 1 }
}

function taskFor(id: string): Task {
  return { id, boardId: 'board-1', title: 'test task', description: '', priority: 'medium', columnId: 'todo', createdAt: 1, updatedAt: 1, attempts: [], comments: [], events: [] }
}

describe('GitService', () => {
  it('initializes a repo when the path is missing (PM-02)', async () => {
    const { dir, git } = fixture()
    const repo = join(dir, 'new-repo')
    assert.equal(await git.isRepo(repo), false)
    await git.ensureRepo(repo, 'main')
    assert.equal(await git.isRepo(repo), true)
    assert.equal(await git.currentBranch(repo), 'main')
  })

  it('creates worktrees with task branches and diffs them (AE-02, CR-01)', async () => {
    const { dir, git } = fixture()
    await git.ensureRepo(dir, 'main')
    writeFileSync(join(dir, 'README.md'), '# base\n')
    await git.commitAll(dir, 'chore: base')

    const board = boardFor(dir)
    const task = taskFor('task-demo')
    const wt = await git.createWorktree(board, task)
    assert.equal(wt.branch, 'herness-task-task-demo')
    assert.equal(wt.path, dir + '-task-demo')

    writeFileSync(join(wt.path, 'feature.txt'), 'hello\nworld\n')
    await git.commitAll(wt.path, 'feat(task-demo): add feature')

    const diff = await git.diffBetween(dir, 'main', wt.branch)
    assert.match(diff, /feature\.txt/)
    assert.match(diff, /\+hello/)

    const summary = await git.getDiffSummary(dir, 'main', wt.branch)
    assert.equal(summary.filesChanged, 1)
    assert.equal(summary.additions, 2)

    await git.removeWorktree(dir, wt.path, wt.branch, true)
    assert.equal(await git.branchExists(dir, wt.branch), false)
  })

  it('reclaims a stale clean worktree slot on re-dispatch (AE-02)', async () => {
    const { dir, git } = fixture()
    await git.ensureRepo(dir, 'main')
    writeFileSync(join(dir, 'README.md'), '# base\n')
    await git.commitAll(dir, 'chore: base')

    const board = boardFor(dir)
    const task = taskFor('task-retry')
    const first = await git.createWorktree(board, task)
    assert.ok(first.path)

    // Simulate a crashed run: the slot still exists but holds no work.
    const second = await git.createWorktree(board, task)
    assert.equal(second.branch, 'herness-task-task-retry')
    assert.equal(second.path, first.path)
    assert.equal(await git.branchExists(dir, second.branch), true)

    await git.removeWorktree(dir, second.path, second.branch, true)
  })

  it('refuses to reclaim a dirty stale worktree (AE-02)', async () => {
    const { dir, git } = fixture()
    await git.ensureRepo(dir, 'main')
    writeFileSync(join(dir, 'README.md'), '# base\n')
    await git.commitAll(dir, 'chore: base')

    const board = boardFor(dir)
    const task = taskFor('task-dirty')
    const wt = await git.createWorktree(board, task)
    writeFileSync(join(wt.path, 'uncommitted.txt'), 'work in progress\n')

    await assert.rejects(
      () => git.createWorktree(board, task),
      (err: Error) => (err as { code?: string }).code === 'WORKTREE_DIRTY',
    )

    await git.removeWorktree(dir, wt.path, wt.branch, true)
  })

  it('refuses to reclaim a stale worktree with commits beyond main (AE-02)', async () => {
    const { dir, git } = fixture()
    await git.ensureRepo(dir, 'main')
    writeFileSync(join(dir, 'README.md'), '# base\n')
    await git.commitAll(dir, 'chore: base')

    const board = boardFor(dir)
    const task = taskFor('task-committed')
    const wt = await git.createWorktree(board, task)
    writeFileSync(join(wt.path, 'feature.txt'), 'reviewable work\n')
    await git.commitAll(wt.path, 'feat: feature')

    await assert.rejects(
      () => git.createWorktree(board, task),
      (err: Error) => (err as { code?: string }).code === 'WORKTREE_EXISTS',
    )

    await git.removeWorktree(dir, wt.path, wt.branch, true)
  })

  it('reclaims an orphaned leftover directory (AE-02)', async () => {
    const { dir, git } = fixture()
    await git.ensureRepo(dir, 'main')
    writeFileSync(join(dir, 'README.md'), '# base\n')
    await git.commitAll(dir, 'chore: base')

    const board = boardFor(dir)
    const task = taskFor('task-orphan')
    // A crashed `git worktree add` can leave an unregistered shell behind.
    mkdirSync(dir + '-task-orphan')
    writeFileSync(join(dir + '-task-orphan', '.git'), 'gitdir: ' + join(dir, '.git') + '/worktrees/ghost\n')

    const wt = await git.createWorktree(board, task)
    assert.equal(wt.branch, 'herness-task-task-orphan')
    assert.equal(await git.branchExists(dir, wt.branch), true)

    await git.removeWorktree(dir, wt.path, wt.branch, true)
  })

  it('merges --no-ff and reverts (CR-03, CR-04)', async () => {
    const { dir, git } = fixture()
    await git.ensureRepo(dir, 'main')
    writeFileSync(join(dir, 'a.txt'), 'base\n')
    await git.commitAll(dir, 'chore: base')

    const board = boardFor(dir)
    const task = taskFor('task-merge')
    const wt = await git.createWorktree(board, task)
    writeFileSync(join(wt.path, 'b.txt'), 'feature\n')
    await git.commitAll(wt.path, 'feat: feature')

    const commit = await git.merge(dir, 'main', wt.branch, task.id)
    assert.ok(commit)
    const content = await git.runSilent(dir, ['show', 'main:b.txt'])
    assert.match(content, /feature/)

    const revertCommit = await git.revert(dir, 'main', wt.branch, task.id)
    assert.ok(revertCommit)
    const after = await git.runSilent(dir, ['show', 'main:b.txt']).catch(() => 'GONE')
    assert.equal(after, 'GONE')

    await git.removeWorktree(dir, wt.path, wt.branch, true)
  })

  it('detects merge conflicts (CR-06)', async () => {
    const { dir, git } = fixture()
    await git.ensureRepo(dir, 'main')
    writeFileSync(join(dir, 'conflict.txt'), 'base\n')
    await git.commitAll(dir, 'chore: base')

    // the task branches from main BEFORE main advances (dispatch-time state)
    const board = boardFor(dir)
    const task = taskFor('task-conflict')
    const wt = await git.createWorktree(board, task)

    // main moves forward while the task is executing
    writeFileSync(join(dir, 'conflict.txt'), 'changed-on-main\n')
    await git.commitAll(dir, 'chore: main change')

    // the task branch changes the same line — a real conflict
    writeFileSync(join(wt.path, 'conflict.txt'), 'changed-on-task\n')
    await git.commitAll(wt.path, 'feat: task change')

    await assert.rejects(
      () => git.merge(dir, 'main', wt.branch, task.id),
      (err: Error) => (err as { code?: string }).code === 'MERGE_CONFLICT',
    )
    await git.removeWorktree(dir, wt.path, wt.branch, true)
  })
})

