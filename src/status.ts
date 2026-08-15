/**
 * Card status badges (KB-07) and column helpers.
 */
import type { Task } from './types.js'

export interface TaskBadges {
  schedule: boolean // ⏰
  blocked: boolean // 🚫
  running: boolean // 🔴
  reviewing: boolean // 👀
  done: boolean // ✅
  failed: boolean // ⚠️
}

export function taskBadges(task: Task): TaskBadges {
  const lastAttempt = task.attempts[task.attempts.length - 1]
  return {
    schedule: !!task.schedule,
    blocked: !!task.isBlocked,
    running: lastAttempt?.status === 'running' || lastAttempt?.status === 'pending',
    reviewing: task.columnId === 'review',
    done: task.columnId === 'done',
    failed: lastAttempt?.status === 'failed' && task.columnId === 'todo',
  }
}

export function renderBadges(task: Task): string {
  const badges = taskBadges(task)
  let out = ''
  if (badges.schedule) out += '⏰'
  if (badges.blocked) out += '🚫'
  if (badges.running) out += '🔴'
  if (badges.reviewing) out += '👀'
  if (badges.done) out += '✅'
  if (badges.failed) out += '⚠️'
  return out
}

/** One-line digest of the latest attempt, for cards and tool results. */
export function latestAttemptSummary(task: Task): string {
  const attempt = task.attempts[task.attempts.length - 1]
  if (!attempt) return ''
  switch (attempt.status) {
    case 'running':
      return '运行中 ' + (attempt.progress ?? 0) + '%'
    case 'pending':
      return '排队中'
    case 'success':
      return attempt.diffSummary ? '改动: ' + attempt.diffSummary : '执行成功'
    case 'failed':
      return '失败: ' + (attempt.error ?? attempt.resultSummary ?? 'unknown error').slice(0, 120)
    case 'stopped':
      return '已停止'
  }
}
