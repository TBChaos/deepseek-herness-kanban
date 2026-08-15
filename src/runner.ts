/**
 * DshAgentRunner — executes a dispatched task inside a real DSH agent session
 * (DS-06). The session inherits the user's model configuration; only the
 * working directory, the task prompt, and one system-prompt section are
 * task-specific.
 *
 * Progress signals (AE-06) are dual: the session event firehose feeds the log
 * signal, and the worktree heartbeat file feeds the progress signal (read by
 * SchedulerService.checkHeartbeat).
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { dispatchPrompt } from './prompt.js'
import type { DispatchOptions, RunningSession, SessionOutcome } from './scheduler.js'

export interface DshAgentRunnerOptions {
  /** Provider/model override for dispatched sessions; undefined = user default. */
  provider?: string
  model?: string
  maxTokens?: number
  /** Forward progress lines to the scheduler's heartbeat log signal (AE-06). */
  onLog?: (options: DispatchOptions, lines: string[]) => void
}

export class DshAgentRunner {
  constructor(private readonly ctx: Context, private readonly options: DshAgentRunnerOptions = {}) {}

  async spawn(options: DispatchOptions): Promise<RunningSession> {
    const sessionId = SessionId('herness-kanban-' + options.task.id + '-' + Date.now().toString(36))
    const board = options.board
    const prompt = dispatchPrompt(options.task, board.name, board.mainBranch, options.branchName)

    const handle: AgentHandle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: options.worktreePath },
      agentOptions: {
        ...(this.options.provider ? { provider: this.options.provider } : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.maxTokens ? { maxTokens: this.options.maxTokens } : {}),
      },
      setup(agentCtx) {
        agentCtx.systemPrompt.section({
          name: 'herness-kanban:dispatch',
          order: 50,
          text: 'You are executing a kanban task inside an isolated Git worktree. Work on the task given in the conversation. Update the .herness/heartbeat.json progress file as you work. Commit your changes on your task branch. When done, finish with a concise summary of what changed.',
        })
      },
    })

    const agent = handle.agent

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

