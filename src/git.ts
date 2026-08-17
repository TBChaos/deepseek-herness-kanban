/**
 * GitService — the Git worktree execution engine.
 *
 * Every operation runs through `node:child_process` so behaviour is identical
 * across platforms (TC-07: Git ≥ 2.25 required). All commands run with
 * `-c core.quotepath=false` for stable UTF-8 output and a fixed C locale.
 */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { branchNameFor, worktreePathFor } from './ids.js'
import type { Board, DiffSummary, FileDiff, Task } from './types.js'

const execFileAsync = promisify(execFile)

const BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'i18n.commitEncoding=utf-8']

export class GitError extends Error {
  readonly code: string
  constructor(message: string, code = 'GIT_ERROR') {
    super(message)
    this.name = 'GitError'
    this.code = code
  }
}

function gitArgs(cwd: string, args: string[]): [string, string[]] {
  return ['git', [...BASE_ARGS, ...args]]
}

async function run(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const [file, fullArgs] = gitArgs(cwd, args)
  try {
    const { stdout, stderr } = await execFileAsync(file, fullArgs, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout + (stderr ? '\n' + stderr : '')
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string }
    const detail = (err.stderr || err.stdout || err.message || '').trim()
    throw new GitError(detail || 'git command failed', 'GIT_ERROR')
  }
}

/** Run a command in a directory that may not exist yet (git init). */
function runIn(dir: string, args: string[]): Promise<string> {
  mkdirSync(dir, { recursive: true })
  return run(dir, args)
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

export interface WorktreeInfo {
  branch: string
  path: string
}

export class GitService {
  /** True when the executable reports ≥ 2.25 (TC-07). */
  static async checkVersion(): Promise<{ ok: boolean; version: string }> {
    try {
      const out = await run(process.cwd(), ['--version'])
      const match = /git version (\d+)\.(\d+)/.exec(out)
      const major = Number(match?.[1] ?? 0)
      const minor = Number(match?.[2] ?? 0)
      return {
        ok: major > 2 || (major === 2 && minor >= 25),
        version: (match ? match[1] + '.' + match[2] : out.trim()) || 'unknown',
      }
    } catch {
      return { ok: false, version: 'not found' }
    }
  }

  /** Exposed for tests: run one git command in `path` and return stdout. */
  async runSilent(path: string, args: string[]): Promise<string> {
    return run(path, args)
  }
  /** Detect a Git repository at `path`; returns null when absent. */
  async isRepo(path: string): Promise<boolean> {
    if (!existsSync(path)) return false
    try {
      const out = await run(path, ['rev-parse', '--is-inside-work-tree'])
      return out.trim() === 'true'
    } catch {
      return false
    }
  }

  /** Resolve the real repository root (the worktree root, not .git/worktrees). */
  async repoRoot(path: string): Promise<string> {
    const out = await run(path, ['rev-parse', '--show-toplevel'])
    const root = out.trim()
    if (!root) throw new GitError('not inside a Git repository')
    return resolve(root)
  }

  /** Initialize a repository when the path does not exist (PM-02). */
  async ensureRepo(path: string, mainBranch = 'main'): Promise<string> {
    if (await this.isRepo(path)) return this.repoRoot(path)
    if (!existsSync(path)) mkdirSync(path, { recursive: true })
    await runIn(path, ['init', '-b', mainBranch])
    // A repository without commits has no branches; create the first one.
    const hasCommits = await this.hasCommits(path)
    if (!hasCommits) {
      // commit an empty .gitkeep so worktrees can be created
      const keep = resolve(path, '.gitkeep')
      if (!existsSync(keep)) {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(keep, '# created by deepseek-herness-kanban to initialize the main branch\n')
        await run(path, ['add', '.gitkeep'])
        await this.commitAll(path, 'chore: initialize repository for kanban board')
      }
    }
    return this.repoRoot(path)
  }

  async hasCommits(path: string): Promise<boolean> {
    try {
      await run(path, ['rev-parse', '--verify', 'HEAD'])
      return true
    } catch {
      return false
    }
  }

  async currentBranch(path: string): Promise<string> {
    const out = await run(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return out.trim().split(/\r?\n/)[0] ?? ''
  }

  async defaultBranchName(path: string): Promise<string> {
    try {
      const out = await run(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      const branch = out.trim().split('/').pop()
      if (branch) return branch
    } catch {
      // no origin — fall through
    }
    const current = await this.currentBranch(path)
    if (current && current !== 'HEAD') return current
    return 'main'
  }

  async listBranches(path: string): Promise<string[]> {
    const out = await run(path, ['branch', '--format=%(refname:short)'])
    return lines(out)
  }

  async branchExists(path: string, branch: string): Promise<boolean> {
    try {
      await run(path, ['rev-parse', '--verify', 'refs/heads/' + branch])
      return true
    } catch {
      return false
    }
  }

  /** True when `branch` has commits not reachable from `base` (i.e. real work). */
  async branchAheadOf(repoPath: string, base: string, branch: string): Promise<boolean> {
    const count = (await run(repoPath, ['rev-list', '--count', base + '..' + branch]).catch(() => '')).trim()
    return count !== '' && count !== '0'
  }

  async commitAll(path: string, message: string, author = 'herness-kanban'): Promise<string> {
    await run(path, ['add', '-A'])
    const status = await this.porcelainStatus(path)
    if (!status.trim()) return ''
    await run(path, ['-c', 'user.name=' + author, '-c', 'user.email=' + author + '@herness-kanban.local', 'commit', '-m', message])
    const out = await run(path, ['rev-parse', 'HEAD'])
    return out.trim()
  }

  async porcelainStatus(path: string): Promise<string> {
    return run(path, ['status', '--porcelain'])
  }

  /** Fetch (when a remote exists) and fast-forward the main branch (CR-07). */
  async syncMain(path: string, mainBranch: string): Promise<void> {
    try {
      await run(path, ['fetch', '--prune', 'origin'], 120_000)
    } catch {
      // no remote or network unavailable — syncing is best-effort
    }
    const current = await this.currentBranch(path)
    const detached = current === 'HEAD'
    if (!detached) {
      try {
        await run(path, ['checkout', mainBranch])
        await run(path, ['merge', '--ff-only', '@{u}'], 120_000)
      } catch {
        // main may not track an upstream — ignore
      } finally {
        if (!detached) await run(path, ['checkout', current]).catch(() => undefined)
      }
    }
  }

  // ---------------------------------------------------------------------
  // Worktree lifecycle (AE-02)
  // ---------------------------------------------------------------------

  async createWorktree(board: Board, task: Task): Promise<WorktreeInfo> {
    const path = worktreePathFor(board, task)
    const branch = branchNameFor(task)
    if (existsSync(path)) {
      await this.reclaimWorktreeSlot(board, path)
    }
    await this.syncMain(board.repoPath, board.mainBranch)
    // New branch starting from the tip of main (CR-07: auto rebase before execution).
    await run(board.repoPath, ['worktree', 'add', '-b', branch, path, 'refs/heads/' + board.mainBranch])
    return { branch, path }
  }

  /**
   * Recover a worktree slot left behind by a previous attempt of the same
   * task (crashed server, interrupted run) so a re-dispatch can start fresh.
   * Only stale plugin-owned worktrees without work are reclaimed:
   *
   * - a registered `herness-task-*` worktree is removed when its branch has
   *   no commits beyond main and no uncommitted changes (removeWorktree
   *   throws WORKTREE_DIRTY otherwise);
   * - an unregistered leftover directory is deleted only when it is empty
   *   or holds nothing but a bare `.git` gitdir pointer.
   *
   * Anything else — foreign worktrees, committed or dirty work — is kept
   * and reported with WORKTREE_EXISTS so no agent work is ever destroyed.
   */
  private async reclaimWorktreeSlot(board: Board, path: string): Promise<void> {
    const registered = (await this.listWorktrees(board.repoPath)).find((wt) => wt.path === path)
    if (registered && registered.branch.startsWith('herness-task-')) {
      const ahead = (await run(board.repoPath, ['rev-list', '--count', board.mainBranch + '..' + registered.branch]).catch(() => '')).trim()
      if (ahead && ahead !== '0') {
        throw new GitError(
          'worktree from a previous attempt still holds commits on ' + registered.branch + '; review or remove it before re-dispatching: ' + path,
          'WORKTREE_EXISTS',
        )
      }
      await this.removeWorktree(board.repoPath, path, registered.branch, false)
      return
    }
    let entries: string[] = []
    try {
      entries = readdirSync(path)
    } catch {
      return // disappeared between the check and now — the slot is free
    }
    const leftovers = entries.filter((entry) => entry !== '.git')
    if (leftovers.length > 0) {
      throw new GitError('worktree path already exists: ' + path, 'WORKTREE_EXISTS')
    }
    rmSync(path, { recursive: true, force: true })
    await run(board.repoPath, ['worktree', 'prune']).catch(() => undefined)
  }

  async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const out = await run(repoPath, ['worktree', 'list', '--porcelain'])
    const result: WorktreeInfo[] = []
    let branch = ''
    let path = ''
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim().replace('refs/heads/', '')
      else if (line === '' && path && branch) {
        result.push({ branch, path })
        branch = ''
        path = ''
      }
    }
    return result
  }

  /** Remove a worktree and its branch (best-effort on uncommitted changes). */
  async removeWorktree(repoPath: string, worktreePath: string, branch: string, force = false): Promise<void> {
    const exists = existsSync(worktreePath)
    if (exists) {
      const dirty = (await this.porcelainStatus(worktreePath).catch(() => '')).trim()
      if (dirty && !force) {
        throw new GitError('worktree has uncommitted changes; refusing to destroy', 'WORKTREE_DIRTY')
      }
      await run(repoPath, ['worktree', 'remove', '--force', worktreePath])
      if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true })
    } else {
      await run(repoPath, ['worktree', 'prune'])
    }
    if (branch && (await this.branchExists(repoPath, branch))) {
      await run(repoPath, ['branch', '-D', branch])
    }
  }

  /** Destroy every worktree created by this plugin for the board. */
  async cleanupBoardWorktrees(board: Board): Promise<void> {
    const worktrees = await this.listWorktrees(board.repoPath)
    for (const wt of worktrees) {
      if (!wt.branch.startsWith('herness-task-')) continue
      await this.removeWorktree(board.repoPath, wt.path, wt.branch, true).catch(() => undefined)
    }
  }

  // ---------------------------------------------------------------------
  // Diff / review (CR-01, CR-02, CR-06)
  // ---------------------------------------------------------------------

  async diffBetween(repoPath: string, base: string, head: string): Promise<string> {
    try {
      return await run(repoPath, ['diff', base + '...' + head, '--find-renames', '--unified=3'], 120_000)
    } catch (error) {
      const err = error as GitError
      throw new GitError('cannot diff ' + base + '...' + head + ': ' + err.message)
    }
  }

  async diffStat(repoPath: string, base: string, head: string): Promise<string> {
    try {
      return await run(repoPath, ['diff', '--stat', base + '...' + head], 120_000)
    } catch {
      return ''
    }
  }

  async diffNameStatus(repoPath: string, base: string, head: string): Promise<Array<[string, string]>> {
    try {
      const out = await run(repoPath, ['diff', '--name-status', base + '...' + head], 120_000)
      return lines(out).map((line) => {
        const [status, ...rest] = line.split(/\s+/)
        return [status ?? '', rest.join(' ')] as [string, string]
      })
    } catch {
      return []
    }
  }

  async getDiffSummary(repoPath: string, base: string, head: string): Promise<DiffSummary> {
    const [raw, nameStatus] = await Promise.all([
      this.diffBetween(repoPath, base, head),
      this.diffNameStatus(repoPath, base, head),
    ])
    const files: FileDiff[] = []
    let additions = 0
    let deletions = 0
    let lastPath = ''
    let lastDiff = ''
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('diff --git ')) {
        if (lastPath) files.push(this.buildFileDiff(lastPath, lastDiff, nameStatus))
        lastDiff = ''
        const match = /diff --git a\/(.*?) b\/(.*)$/.exec(line)
        lastPath = (match?.[2] || '').trim()
        if (lastPath === '/dev/null') lastPath = (match?.[1] || '').trim()
      }
      lastDiff += line + '\n'
    }
    if (lastPath) files.push(this.buildFileDiff(lastPath, lastDiff, nameStatus))
    for (const file of files) {
      additions += file.additions
      deletions += file.deletions
    }
    const mergeable = files.length >= 0
    return {
      files,
      additions,
      deletions,
      filesChanged: files.length,
      mergeable,
    }
  }

  private buildFileDiff(path: string, diff: string, nameStatus: Array<[string, string]>): FileDiff {
    const additions = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
    const deletions = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length
    let kind: FileDiff['kind'] = 'modified'
    for (const [status, name] of nameStatus) {
      if (name === path) {
        kind = status.startsWith('A') ? 'added' : status.startsWith('D') ? 'deleted' : status.startsWith('R') ? 'renamed' : 'modified'
        break
      }
    }
    return { path, kind, diff: diff.trimEnd(), additions, deletions }
  }

  // ---------------------------------------------------------------------
  // Merge / revert (CR-03, CR-04)
  // ---------------------------------------------------------------------

  /** Commit any pending changes on the task branch, then check mergeability. */
  async prepareForMerge(board: Board, task: Task, attempt?: { branchName?: string; worktreePath?: string }): Promise<{ branch: string; hasChanges: boolean }> {
    const branch = attempt?.branchName ?? branchNameFor(task)
    const worktreePath = attempt?.worktreePath ?? worktreePathFor(board, task)
    if (!(await this.branchExists(board.repoPath, branch))) {
      throw new GitError('task branch does not exist: ' + branch, 'BRANCH_MISSING')
    }
    let hasChanges = false
    if (existsSync(worktreePath)) {
      const status = await this.porcelainStatus(worktreePath)
      if (status.trim()) {
        hasChanges = true
        await this.commitAll(worktreePath, 'feat(' + task.id + '): ' + task.title)
      }
    }
    return { branch, hasChanges }
  }

  async hasUnmergedConflicts(repoPath: string): Promise<string[]> {
    try {
      const out = await run(repoPath, ['diff', '--name-only', '--diff-filter=U'])
      return lines(out)
    } catch {
      return []
    }
  }

  async merge(repoPath: string, mainBranch: string, taskBranch: string, taskId: string): Promise<string> {
    const current = await this.currentBranch(repoPath)
    try {
      await run(repoPath, ['checkout', mainBranch])
      await run(repoPath, ['merge', '--no-ff', taskBranch, '-m', 'Merge task ' + taskId + ' (' + taskBranch + ')'], 120_000)
      const out = await run(repoPath, ['rev-parse', 'HEAD'])
      return out.trim()
    } catch (error) {
      const conflicts = await this.hasUnmergedConflicts(repoPath)
      if (conflicts.length > 0) {
        await run(repoPath, ['merge', '--abort']).catch(() => undefined)
        throw new GitError('merge conflicts in: ' + conflicts.join(', '), 'MERGE_CONFLICT')
      }
      throw error
    } finally {
      await run(repoPath, ['checkout', current]).catch(() => undefined)
    }
  }

  /**
   * Revert a merged task commit (CR-04). When the task branch was never
   * merged into main (no `Merge task <id>` commit exists), main is untouched
   * and nothing needs reverting — the caller still destroys the worktree and
   * branch, and the card returns to todo.
   */
  async revert(repoPath: string, mainBranch: string, taskBranch: string, taskId: string): Promise<string | undefined> {
    const current = await this.currentBranch(repoPath)
    try {
      await run(repoPath, ['checkout', mainBranch])
      let mergeCommit = ''
      try {
        // the merge commit is the most recent merge of the task branch
        const out = await run(repoPath, ['log', '-1', '--merges', '--format=%H', '--grep=' + taskId])
        mergeCommit = out.trim().split(/\r?\n/)[0] ?? ''
      } catch {
        mergeCommit = ''
      }
      if (!mergeCommit) return undefined
      await run(repoPath, ['revert', '--no-edit', '-m', '1', mergeCommit], 120_000)
      const out = await run(repoPath, ['rev-parse', 'HEAD'])
      return out.trim()
    } finally {
      await run(repoPath, ['checkout', current]).catch(() => undefined)
    }
  }

  /** A mergeable check: is the task branch an ancestor-free side branch of main? */
  async canMerge(repoPath: string, mainBranch: string, taskBranch: string): Promise<boolean> {
    try {
      await run(repoPath, ['merge-base', '--is-ancestor', 'refs/heads/' + mainBranch, 'refs/heads/' + taskBranch])
      return true
    } catch {
      return false
    }
  }
}

/** Singleton convenience export; the plugin wires its own instance per ctx. */
export const git = new GitService()

/** Resolve a worktree path that may be relative against the board repo. */
export function resolveWorktree(base: string, path: string): string {
  return resolve(dirname(base), path)
}
