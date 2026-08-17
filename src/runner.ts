/**
 * DshAgentRunner — executes a dispatched task inside a real DSH agent session
 * (DS-06). The session inherits the user's model configuration; only the
 * working directory, the task prompt, and one system-prompt section are
 * task-specific.
 *
 * Progress signals (AE-06) are dual: the session event firehose feeds the log
 * signal, and the worktree heartbeat file feeds the progress signal (read by
 * SchedulerService.checkHeartbeat).
 *
 * Workspace integration: every spawned session is attached to the DSH
 * workspace registry (via {@link DshAgentRunnerOptions.onSessionWorkspace})
 * so it never shows up as “ungrouped” in the GUI — dispatched sessions land
 * in the PROJECT workspace (their cwd is the board's repo path), while the
 * task worktree stays the place where all actual file/git work happens.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installModelSelection, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { discussionPrompt, dispatchPrompt } from './prompt.js'
import type { Board, Task } from './types.js'
import type { DispatchOptions, RunningSession, SessionOutcome } from './scheduler.js'

export interface DshAgentRunnerOptions {
  /** Provider/model override for dispatched sessions; undefined = user default. */
  provider?: string
  model?: string
  maxTokens?: number
  /** Optional agent preset (mode) to mount for dispatched sessions. */
  agentPreset?: string
  /** Optional reasoning effort to install for dispatched sessions. */
  reasoningEffort?: string
  /** Forward progress lines to the scheduler's heartbeat log signal (AE-06). */
  onLog?: (options: DispatchOptions, lines: string[]) => void
  /**
   * Attach a freshly created session to the workspace registry so it is
   * grouped under a workspace (not “ungrouped”) in the DSH GUI. The callback
   * registers the directory (if not registered yet) and attaches the session.
   */
  onSessionWorkspace?: (path: string, title: string, sessionId: string) => Promise<void>
}

/** Input for spawning a task-scoped refinement discussion session (Req 3). */
export interface DiscussionOptions {
  task: Task
  board: Board
}

export class DshAgentRunner {
  constructor(private readonly ctx: Context, private readonly options: DshAgentRunnerOptions = {}) {}

  async spawn(options: DispatchOptions): Promise<RunningSession> {
    const sessionId = SessionId('herness-kanban-' + options.task.id + '-' + Date.now().toString(36))
    const board = options.board
    const prompt = dispatchPrompt(options.task, board, options.branchName, options.worktreePath)

    const runnerOptions = options.runner ?? {}
    const provider = runnerOptions.provider ?? this.options.provider
    const model = runnerOptions.model ?? this.options.model
    const maxTokens = runnerOptions.maxTokens ?? this.options.maxTokens
    const reasoningEffort = runnerOptions.reasoningEffort ?? this.options.reasoningEffort
    const agentPreset = runnerOptions.agentPreset ?? this.options.agentPreset
    const mode = runnerOptions.mode ?? (agentPreset ? 'agent' : 'api')
    const usePreset = mode !== 'api' && !!agentPreset

    const handle: AgentHandle = await this.ctx.agents.create({
      sessionId,
      meta: {
        // Req 1 (revised): the session's cwd is the PROJECT path (<repoPath>),
        // not the worktree path — so it lands in the project workspace in the
        // GUI. All actual task work happens inside the worktree directory,
        // which the dispatch prompt pins down explicitly.
        cwd: board.repoPath,
        ...(usePreset && agentPreset ? { agentPreset } : {}),
      },
      agentOptions: {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(maxTokens ? { maxTokens } : {}),
      },
      async setup(agentCtx) {
        if (usePreset && agentPreset) {
          const agentPresets = agentCtx.get('agentPresets') as { mount(ctx: unknown, id?: string): Promise<unknown> } | undefined
          if (!agentPresets) throw new Error('agentPresets service is not available; cannot mount preset ' + agentPreset)
          await agentPresets.mount(agentCtx, agentPreset)
        }
        if (provider && model) {
          installModelSelection(agentCtx, {
            current: {
              provider,
              model,
              ...(reasoningEffort ? { reasoningEffort: reasoningEffort as ReasoningEffortId } : {}),
            },
            assembled: undefined,
          })
        }
        agentCtx.systemPrompt.section({
          name: 'herness-kanban:dispatch',
          order: 50,
          text: 'You are executing a kanban task. Your session working directory is the main repository, but ALL task work — file edits, git commands, the heartbeat file — must happen inside your dedicated worktree at ' + options.worktreePath + '. Never modify the main repository. Update .herness/heartbeat.json (inside the worktree) as you work. Commit your changes on branch ' + options.branchName + '. When done, finish with a concise summary of what changed.',
        })
      },
    })

    const agent = handle.agent

    // Req 1: land the session in the PROJECT workspace (repoPath) so it is
    // never “ungrouped” and no per-task workspace appears in the GUI.
    if (this.options.onSessionWorkspace && agent.id) {
      try {
        await this.options.onSessionWorkspace(board.repoPath, board.name, agent.id)
      } catch (error) {
        // workspace registration is best-effort; the run itself is unaffected
        this.ctx.logger('herness-kanban').warn('workspace registration failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }

    // ---- outcome plumbing (all in spawn scope) ----
    let settled = false
    let stopped = false
    let lastError: string | undefined
    let sawRunning = false
    const disposers: Array<() => void> = []
    const logBuffer: string[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flushLogs = () => {
      flushTimer = null
      if (logBuffer.length === 0) return
      const lines = logBuffer.splice(0)
      this.options.onLog?.(options, lines)
    }

    const pushLog = (line: string) => {
      const clean = line.replace(/\s+/g, ' ').trim()
      if (!clean) return
      logBuffer.push(clean)
      if (logBuffer.length >= 20) flushLogs()
      else {
        if (flushTimer) clearTimeout(flushTimer)
        flushTimer = setTimeout(flushLogs, 500)
      }
    }

    let settleFn: ((result: SessionOutcome) => void) | null = null
    const outcome = new Promise<SessionOutcome>((resolve) => {
      const settle = (result: SessionOutcome) => {
        if (settled) return
        settled = true
        if (flushTimer) clearTimeout(flushTimer)
        flushLogs()
        for (const dispose of disposers.splice(0)) dispose()
        resolve(result)
      }
      settleFn = settle

      disposers.push(this.ctx.on('session/event', (session: { id: string }, event: { type: string; chunk?: { type?: string; text?: string }; name?: string }) => {
        if (session.id !== agent.id) return
        if (event.type === 'assistant/chunk') {
          const chunk = event.chunk
          if (chunk?.type === 'text-delta' && chunk.text) pushLog(chunk.text)
        } else if (event.type === 'tool/call') {
          pushLog('[tool] ' + (event.name ?? ''))
        }
      }))

      disposers.push(this.ctx.on('agent/status', (payload: { agent: Agent; status: string }) => {
        if (payload.agent.id !== agent.id) return
        if (payload.status === 'running') sawRunning = true
        if (payload.status === 'idle' && sawRunning) {
          const summary = extractSummary(agent)
          if (lastError) settle({ status: 'failed', error: lastError, summary })
          else if (stopped) settle({ status: 'stopped', summary })
          else settle({ status: 'success', summary: summary || 'completed' })
        }
      }))

      disposers.push(this.ctx.on('agent/error', (payload: { agent: Agent; error: unknown }) => {
        if (payload.agent.id !== agent.id) return
        lastError = payload.error instanceof Error ? payload.error.message : String(payload.error)
        pushLog('[error] ' + lastError)
      }))
    })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))

    return {
      sessionId: agent.id,
      wait: async () => outcome,
      stop: async () => {
        stopped = true
        try {
          agent.cancel({ kind: 'hook', reason: 'herness-kanban stop_task' })
          await handle.dispose()
        } catch {
          // disposal already in flight — ignore
        }
        // The agent may never reach idle during disposal; settle directly.
        settleFn?.({ status: 'stopped', summary: 'stopped by herness_kanban_stop_task' })
      },
    }
  }

  /**
   * Req 3 — spawn an interactive refinement conversation for a todo task.
   * The session's context contains ONLY the card's own content (description,
   * comments, events, attempt history) seeded as its first user message; the
   * user chats with it in the GUI to sharpen the requirements, and the agent
   * records the results back on the card. Its cwd is the board repository so
   * it lands in the project workspace.
   */
  async spawnDiscussion(options: DiscussionOptions): Promise<string> {
    const { task, board } = options
    const sessionId = SessionId('herness-discuss-' + task.id + '-' + Date.now().toString(36))

    const handle: AgentHandle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: board.repoPath },
      agentOptions: {
        ...(this.options.provider ? { provider: this.options.provider } : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.maxTokens ? { maxTokens: this.options.maxTokens } : {}),
      },
      async setup(agentCtx) {
        agentCtx.systemPrompt.section({
          name: 'herness-kanban:discussion',
          order: 50,
          text:
            'You are helping the user refine the requirements of ONE kanban task card. ' +
            'Your conversation context contains only this card — nothing else on the board. ' +
            'Stay focused on this task: clarify goals, acceptance criteria, scope and edge cases. ' +
            'When the user agrees on a point, update the card with herness_kanban_update_description ' +
            '(full new description) and record decisions with herness_kanban_add_comment. ' +
            'Never dispatch, execute, merge or delete the task — refinement only.',
        })
      },
    })

    const agent = handle.agent
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: discussionPrompt(task, board) }],
      source: { kind: 'user' },
    }))

    return agent.id
  }
}

/** Best-effort summary from the agent's last assistant text. */
function extractSummary(agent: Agent): string | undefined {
  try {
    const events = [...agent.session.events].reverse()
    for (const record of events) {
      if (record.type === 'assistant/message') {
        const message = (record as unknown as { message?: { content?: Array<{ type?: string; text?: string }> } }).message
        const text = (message?.content ?? [])
          .filter((b): b is { type: 'text'; text: string } => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim()
        if (text) {
          const lines = text.split(/\r?\n/).filter(Boolean)
          return lines.slice(-6).join(' ').slice(0, 500)
        }
      }
    }
  } catch {
    // reading a live session defensively — ignore
  }
  return undefined
}

