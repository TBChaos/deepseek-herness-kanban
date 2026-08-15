/**
 * deepseek-herness-kanban — the DSH plugin entry (host plane).
 *
 * Composition (plan §9):
 *   Host plane  — KanbanStore (storage domain), GitService, SchedulerService,
 *                 HTTP RPC /herness-kanban/rpc + SSE /herness-kanban/events.
 *   Client plane— 17 herness_kanban_* agent tools, herness-kanban skill,
 *                 and the 📋 board tab (see ./client export).
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { kanbanDomainSpec } from './domain.js'
import { GitService } from './git.js'
import { DomainBackend, KanbanStore } from './store.js'
import { SchedulerService } from './scheduler.js'
import { DshAgentRunner } from './runner.js'
import { KanbanService } from './service.js'
import { registerTools } from './tools/index.js'
import { registerSkill } from './skill.js'
import { createRpcHttpHandler, createRpcRegistry, createSseHandler, registerRpcHandlers, type RpcRegistry } from './rpc.js'

export const name = 'deepseek-herness-kanban'
export const inject = ['tools', 'storageDomain', 'skills']

export interface Config {
  /** Max concurrently executing tasks (NF-06). Default 5. */
  maxConcurrent: number
  /** Heartbeat timeout in ms; runs with no signal are stopped (NF-10). Default 30min. */
  heartbeatTimeoutMs: number
  /** Override the worktree parent dir; default '<repoPath>-<taskId>'. */
  worktreeBaseDir: string | null
  /** Provider/model override for dispatched sessions; null = user defaults. */
  dispatchProvider: string | null
  dispatchModel: string | null
  dispatchMaxTokens: number | null
}

export const Config = z.object({
  maxConcurrent: z.natural().min(1).default(5),
  heartbeatTimeoutMs: z.natural().min(60_000).default(1_800_000),
  worktreeBaseDir: z.union([z.string(), z.const(null)]).default(null),
  dispatchProvider: z.union([z.string(), z.const(null)]).default(null),
  dispatchModel: z.union([z.string(), z.const(null)]).default(null),
  dispatchMaxTokens: z.union([z.natural(), z.const(null)]).default(null),
})

/** Extract plain text from a session-derived message list. */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
}

/**
 * apply — one KanbanService instance per activation; every registration is a
 * ctx.effect disposer so unloading the plugin tears everything down (NF-04).
 */
export async function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name)
  const worktreesBase = config.worktreeBaseDir
  void worktreesBase

  // ---- storage (DS-05) ----
  const domain = await ctx.storageDomain.open(kanbanDomainSpec)
  ctx.effect(() => () => { void domain.close() })
  const store = new KanbanStore(new DomainBackend(domain))

  // ---- git (TC-07) ----
  const gitService = new GitService()
  void GitService.checkVersion().then((v) => {
    if (!v.ok) logger.warn('git >= 2.25 required for worktree isolation, found: ' + v.version)
  })

  // ---- rpc plumbing (DS-04) — created even before webServer exists ----
  const rpc: RpcRegistry = createRpcRegistry()
  let publishPing: (() => void) | null = null

  // ---- dispatch runner + scheduler ----
  // The runner feeds session activity into the scheduler's heartbeat log
  // signal; the scheduler is built just below, so the seam is a holder.
  let reportActivity: ((options: import('./scheduler.js').DispatchOptions, lines: string[]) => void) | null = null
  const runner = new DshAgentRunner(ctx, {
    provider: config.dispatchProvider ?? undefined,
    model: config.dispatchModel ?? undefined,
    maxTokens: config.dispatchMaxTokens ?? undefined,
    onLog: (options, lines) => reportActivity?.(options, lines),
  })
  const scheduler = new SchedulerService(store, gitService, runner, {
    maxConcurrent: config.maxConcurrent,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    onSettled: (taskId, outcome) => {
      const task = store.getTaskOrNull(taskId)
      if (task) {
        rpc.publish({ type: 'task_settled', payload: { taskId, status: outcome.status, title: task.title } })
        if (outcome.status === 'failed') {
          rpc.publish({ type: 'toast', payload: { kind: 'error', title: '任务执行失败', message: task.title + ': ' + (outcome.error ?? '').slice(0, 200) } })
        } else if (outcome.status === 'success') {
          rpc.publish({ type: 'toast', payload: { kind: 'success', title: '任务执行完成', message: task.title + ' 进入审查' } })
        }
      }
    },
    onStart: (taskId) => {
      publishPing?.()
      rpc.publish({ type: 'task_started', payload: { taskId } })
    },
  })
  ctx.effect(() => () => { void scheduler.dispose() })
  reportActivity = (options, lines) => scheduler.reportActivity(options.task.id, options.attempt.id, lines)

  // ---- LLM completion seam (parse_conversation, DC-01) ----
  const complete = async (system: string, user: string, agent?: Agent): Promise<string> => {
    let provider = agent?.options.provider ?? config.dispatchProvider ?? undefined
    let model = agent?.options.model ?? config.dispatchModel ?? undefined
    if (!provider || !model) {
      const first = ctx.llm.listProviders()[0]
      if (!first) throw new Error('no LLM provider registered; cannot parse conversation')
      provider = first.id
      model = model ?? 'deepseek-chat'
    }
    const prepared = await ctx.llm.prepareCall({ provider, model, maxTokens: 4096 })
    const messages = [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } })]
    let text = ''
    for await (const chunk of prepared.stream({ provider, model, maxTokens: 4096, messages, system })) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    return text
  }

  const readSessionTranscript = async (sessionId: string): Promise<Array<{ role: string; content: string }>> => {
    try {
      const session = ctx.sessions.get(brandSessionId(sessionId))
      if (!session) return []
      const messages = session.deriveMessages()
      return messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: textOfContent(m.content) })).filter((m) => m.content)
    } catch {
      return []
    }
  }

  // ---- business facade ----
  const service = new KanbanService({
    store,
    git: gitService,
    scheduler,
    complete: (system, user, agent) => complete(system, user, agent as Agent | undefined),
    readSessionTranscript,
    notify: (title, message, kind = 'info') => rpc.publish({ type: 'toast', payload: { kind, title, message } }),
  })

  // ---- agent tools (DS-01) + skill (DS-02) ----
  const toolDisposers = registerTools(ctx, service)
  ctx.effect(() => () => { for (const dispose of toolDisposers.reverse()) dispose() })
  ctx.effect(() => registerSkill(ctx))

  // ---- timers (TA-01..TA-04) ----
  scheduler.armTimers()
  ctx.effect(() => {
    const timerSweep = setInterval(() => scheduler.reconcileTimers(), 30_000)
    return () => clearInterval(timerSweep)
  }, 'herness-kanban: timer sweep')

  // ---- RPC + SSE over the web server (DS-04) — optional seam ----
  ctx.inject(['webServer'], (webCtx) => {
    registerRpcHandlers(rpc, service)
    webCtx.webServer.register({ kind: 'exact', path: '/herness-kanban/rpc', handler: createRpcHttpHandler(rpc, service) })
    webCtx.webServer.register({ kind: 'exact', path: '/herness-kanban/events', handler: createSseHandler(rpc) })
    // durable-domain changes → SSE ping → client re-reads its snapshot
    let pingTimer: ReturnType<typeof setTimeout> | null = null
    publishPing = () => {
      if (pingTimer) return
      pingTimer = setTimeout(() => {
        pingTimer = null
        rpc.publish({ type: 'board_changed' })
      }, 250)
    }
    ctx.on('domain/changed', () => publishPing?.())
  })
}

