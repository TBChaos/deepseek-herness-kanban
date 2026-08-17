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
export const inject = ['tools', 'storageDomain', 'skills', 'agents', 'llm', 'sessions', 'agentDefaultModel', 'agentPresets']

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
  /** Default agent preset (mode) for dispatched sessions; null = no preset. */
  dispatchAgentPreset: string | null
  /** Default reasoning effort for dispatched sessions; null = provider/default. */
  dispatchReasoningEffort: string | null
}

export const Config = z.object({
  maxConcurrent: z.natural().min(1).default(5),
  heartbeatTimeoutMs: z.natural().min(60_000).default(1_800_000),
  worktreeBaseDir: z.union([z.string(), z.const(null)]).default(null),
  dispatchProvider: z.union([z.string(), z.const(null)]).default(null),
  dispatchModel: z.union([z.string(), z.const(null)]).default(null),
  dispatchMaxTokens: z.union([z.natural(), z.const(null)]).default(null),
  dispatchAgentPreset: z.union([z.string(), z.const(null)]).default(null),
  dispatchReasoningEffort: z.union([z.string(), z.const(null)]).default(null),
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
 * Minimal structural view of `ctx.workspaceRegistry` (dsh-workspace). Kept
 * local so the plugin never hard-depends on the registry package: when it is
 * absent, sessions simply stay ungrouped.
 */
interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<{ id: string; attachSession(sessionId: string): Promise<void> }>
  delete(id: string): Promise<boolean>
}

/**
 * Tracks the workspace records this plugin registered (one per task worktree,
 * plus the board repo for discussion sessions) so they can be removed again
 * when the underlying directory is destroyed — otherwise the GUI would keep
 * showing stale “missing-dir” workspaces.
 */
function createWorkspaceTracker(ctx: Context, logger: ReturnType<Context['logger']>) {
  const byPath = new Map<string, string>()
  const registry = (): WorkspaceRegistryLike | undefined => ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  return {
    byPath,
    /** Register `path` as a workspace (idempotent) and attach a session to it. */
    async attach(path: string, title: string, sessionId: string): Promise<void> {
      const reg = registry()
      if (!reg) return
      try {
        const ws = await reg.create(path, title)
        byPath.set(path, ws.id)
        if (sessionId) await ws.attachSession(sessionId)
      } catch (error) {
        logger.warn('workspace attach failed for ' + path + ': ' + (error instanceof Error ? error.message : String(error)))
      }
    },
    /** Remove the workspace record for a destroyed directory, if we created it. */
    async remove(path: string): Promise<void> {
      const reg = registry()
      const id = byPath.get(path)
      if (!reg || !id) return
      try {
        await reg.delete(id)
      } catch (error) {
        logger.warn('workspace removal failed for ' + path + ': ' + (error instanceof Error ? error.message : String(error)))
      }
      byPath.delete(path)
    },
  }
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
  const defaultModelSelection = (ctx.get('agentDefaultModel') as { currentSelection(): { provider?: string; model?: string; reasoningEffort?: string } } | undefined)?.currentSelection?.()
  let reportActivity: ((options: import('./scheduler.js').DispatchOptions, lines: string[]) => void) | null = null
  // Req 1: dispatched/discussion sessions land in a workspace, never “ungrouped”.
  const workspaceTracker = createWorkspaceTracker(ctx, logger)
  const runner = new DshAgentRunner(ctx, {
    provider: config.dispatchProvider ?? defaultModelSelection?.provider,
    model: config.dispatchModel ?? defaultModelSelection?.model,
    maxTokens: config.dispatchMaxTokens ?? undefined,
    agentPreset: config.dispatchAgentPreset ?? undefined,
    reasoningEffort: config.dispatchReasoningEffort ?? defaultModelSelection?.reasoningEffort,
    onLog: (options, lines) => reportActivity?.(options, lines),
    onSessionWorkspace: (path, title, sessionId) => workspaceTracker.attach(path, title, sessionId),
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
    // stale workspace records are dropped when their worktree directory dies
    onWorktreeRemoved: (path) => void workspaceTracker.remove(path),
  })
  ctx.effect(() => () => { void scheduler.dispose() })
  reportActivity = (options, lines) => scheduler.reportActivity(options.task.id, options.attempt.id, lines)

  // ---- LLM completion seam (parse_conversation, DC-01) ----
  const complete = async (system: string, user: string, agent?: Agent): Promise<string> => {
    let provider = agent?.options.provider ?? config.dispatchProvider ?? defaultModelSelection?.provider
    let model = agent?.options.model ?? config.dispatchModel ?? defaultModelSelection?.model
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

  // ---- dispatch catalog for the UI (presets/models/efforts) ----
  const getDispatchCatalog = async () => {
    const defaultModel = ctx.get('agentDefaultModel') as { currentSelection(): { provider?: string; model?: string; reasoningEffort?: string } } | undefined
    const agentPresets = ctx.get('agentPresets') as { defaultId: string; list(): Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>> } | undefined
    const defaults = defaultModel?.currentSelection?.() ?? {}
    const defaultPreset = agentPresets?.defaultId
    const presets = agentPresets ? (await agentPresets.list()).map((p) => ({ id: p.id, name: p.name ?? p.id, description: p.description, broken: p.broken })) : []
    const providers = await Promise.all(ctx.llm.listProviders().map(async (provider) => {
      let models: Array<{ id: string; name: string; reasoningEfforts?: Array<{ id: string; name: string; description?: string }>; defaultEffort?: string }> = []
      try {
        const infos = await ctx.llm.listModels(provider.id)
        models = await Promise.all(infos.map(async (info) => {
          const model: { id: string; name: string; reasoningEfforts?: Array<{ id: string; name: string; description?: string }>; defaultEffort?: string } = { id: info.id, name: info.name }
          try {
            const resolved = await ctx.llm.resolveModelInfo(provider.id, info.id)
            if (resolved.reasoning) {
              model.reasoningEfforts = resolved.reasoning.efforts.map((e) => ({ id: e.id, name: e.name, description: e.description }))
              if (resolved.reasoning.defaultEffort) model.defaultEffort = resolved.reasoning.defaultEffort
            }
          } catch {
            // model-level reasoning metadata is advisory
          }
          return model
        }))
      } catch {
        // provider model listing is advisory
      }
      // Keep the current session's selection visible even when the adapter does
      // not advertise it (catalog membership is advisory).
      if (provider.id === defaults.provider && defaults.model && !models.some((m) => m.id === defaults.model)) {
        models.push({ id: defaults.model, name: defaults.model })
      }
      if (provider.id === defaults.provider && defaults.model && defaults.reasoningEffort) {
        const current = models.find((m) => m.id === defaults.model)
        if (current && !current.reasoningEfforts?.some((e) => e.id === defaults.reasoningEffort)) {
          current.reasoningEfforts = [...(current.reasoningEfforts ?? []), { id: defaults.reasoningEffort, name: defaults.reasoningEffort }]
          if (!current.defaultEffort) current.defaultEffort = defaults.reasoningEffort
        }
      }
      return { id: provider.id, name: provider.name, models }
    }))
    return {
      presets,
      providers,
      defaults: {
        mode: (defaultPreset ? 'agent' : 'api') as 'agent' | 'api',
        agentPreset: defaultPreset,
        provider: defaults.provider,
        model: defaults.model,
        reasoningEffort: defaults.reasoningEffort,
      },
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
    getDispatchCatalog,
    // Req 3: task-scoped refinement conversations, context = the card only.
    startDiscussionSession: (task, board) => runner.spawnDiscussion({ task, board }),
    // Req 1: sessions always land in a workspace; stale records are removed
    // when their worktree directory is destroyed.
    onSessionWorkspace: (path, title, sessionId) => workspaceTracker.attach(path, title, sessionId),
    onWorktreeRemoved: (path) => void workspaceTracker.remove(path),
  })

  // ---- startup self-heal (worktree sweep) ----
  // Task worktrees live only while a run is active or a card sits in review.
  // After a restart no agent session survives, so any leftover herness-task-*
  // worktree whose card is not in review is dead weight: destroy what is
  // provably disposable (no commits beyond main, no uncommitted changes),
  // drop the durable workspace record for the swept directory, and return
  // cards that a crash left in 'doing' to todo so they can be re-dispatched.
  // Resolve lazily — the workspace registry may not be initialized yet at
  // plugin apply time.
  const registryNow = () => ctx.get('workspaceRegistry') as
    | (WorkspaceRegistryLike & { list?(): Array<{ id: string; path: string }> })
    | undefined
  void (async () => {
    for (const board of store.listBoards()) {
      const worktrees = await gitService.listWorktrees(board.repoPath).catch(() => [])
      for (const wt of worktrees) {
        if (!wt.branch.startsWith('herness-task-')) continue
        const task = store.getTaskOrNull(wt.branch.slice('herness-task-'.length))
        // a review card keeps its worktree until the human decides (merge/reject/revert)
        if (task?.columnId === 'review') continue
        // A crash may have left the card mid-run with a dead attempt: settle
        // it (doing → todo) so the card is actionable again and the GUI stops
        // showing it as running.
        const latest = task?.attempts[task.attempts.length - 1]
        if (task && latest && (latest.status === 'running' || latest.status === 'pending')) {
          await store.settleAttempt(task.id, latest.id, { status: 'stopped', summary: 'server restart left the attempt dead; worktree swept' }).catch(() => undefined)
          await store.recordEvent(task.id, 'recovered', { worktree: wt.path }).catch(() => undefined)
        }
        try {
          // only clean stale slots are destroyed — agent work is never dropped
          if (await gitService.branchAheadOf(board.repoPath, board.mainBranch, wt.branch)) {
            logger.warn('kept stale worktree with commits on ' + wt.branch + ': ' + wt.path)
            continue
          }
          await gitService.removeWorktree(board.repoPath, wt.path, wt.branch, false)
        } catch (error) {
          logger.warn('kept stale worktree ' + wt.path + ': ' + (error instanceof Error ? error.message : String(error)))
          continue
        }
        const registry = registryNow()
        if (registry) {
          for (const ws of registry.list?.() ?? []) {
            if (ws.path === wt.path) {
              try {
                await registry.delete(ws.id)
              } catch {
                // best-effort — a stale workspace record is cosmetic
              }
            }
          }
        }
        logger.info('swept stale task worktree ' + wt.path + ' (' + wt.branch + ')')
      }
    }
  })()

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

