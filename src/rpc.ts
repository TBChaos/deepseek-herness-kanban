/**
 * RPC endpoint (DS-04): POST /herness-kanban/rpc + SSE /herness-kanban/events.
 *
 * The web board calls these routes over the same origin as the DSH Web GUI.
 * The SSE channel pushes change pings so the board re-reads its snapshot
 * without polling (NF-12).
 */
import type { ServerResponse } from 'node:http'
import type { KanbanService } from './service.js'

export interface RpcRequest {
  method: string
  args?: Record<string, unknown>
}

type RpcHandler = (args: Record<string, unknown>, service: KanbanService) => Promise<unknown>

export interface RpcRegistry {
  handlers: Map<string, RpcHandler>
  sseClients: Set<ServerResponse>
  publish(event: { type: string; payload?: unknown }): void
}

export function createRpcRegistry(): RpcRegistry {
  return {
    handlers: new Map(),
    sseClients: new Set(),
    publish(event) {
      const frame = 'data: ' + JSON.stringify(event) + '\n\n'
      for (const res of this.sseClients) {
        try {
          res.write(frame)
        } catch {
          this.sseClients.delete(res)
        }
      }
    },
  }
}

export function registerRpcHandlers(rpc: RpcRegistry, service: KanbanService): void {
  const handle = (method: string, fn: RpcHandler) => rpc.handlers.set(method, fn)

  handle('boards.list', async () => service.listBoards())
  handle('boards.create', async (args) => service.createBoard({
    name: String(args.name ?? ''),
    description: typeof args.description === 'string' ? args.description : undefined,
    repoPath: String(args.repoPath ?? ''),
    mainBranch: typeof args.mainBranch === 'string' ? args.mainBranch : undefined,
  }))
  handle('boards.delete', async (args) => {
    await service.deleteBoard(String(args.boardId))
    return { ok: true }
  })

  handle('tasks.list', async (args) => service.listTasks(typeof args.boardId === 'string' ? args.boardId : undefined))
  handle('tasks.get', async (args) => service.getTask(String(args.taskId)))
  handle('tasks.create', async (args) => service.createTask({
    boardId: String(args.boardId ?? ''),
    title: String(args.title ?? ''),
    description: typeof args.description === 'string' ? args.description : '',
    priority: ['low','medium','high','critical'].includes(String(args.priority)) ? args.priority as 'low'|'medium'|'high'|'critical' : 'medium',
    assignee: typeof args.assignee === 'string' ? args.assignee : undefined,
    parentTaskId: typeof args.parentTaskId === 'string' ? args.parentTaskId : undefined,
    schedule: args.schedule as { type: 'interval'; interval: number } | { type: 'daily'; dailyTime: string } | undefined,
  }))
  handle('tasks.update', async (args) => service.updateTask(String(args.taskId), {
    title: typeof args.title === 'string' ? args.title : undefined,
    description: typeof args.description === 'string' ? args.description : undefined,
    priority: ['low','medium','high','critical'].includes(String(args.priority)) ? args.priority as 'low'|'medium'|'high'|'critical' : undefined,
    assignee: args.assignee === null ? null : typeof args.assignee === 'string' ? args.assignee : undefined,
    isBlocked: typeof args.isBlocked === 'boolean' ? args.isBlocked : undefined,
    blockReason: typeof args.blockReason === 'string' ? args.blockReason : undefined,
    schedule: args.schedule === null ? null : args.schedule as { type: 'interval'; interval: number } | { type: 'daily'; dailyTime: string } | undefined,
    columnId: ['todo','doing','review','done'].includes(String(args.columnId)) ? args.columnId as 'todo'|'doing'|'review'|'done' : undefined,
  }))
  handle('tasks.delete', async (args) => {
    await service.deleteTask(String(args.taskId))
    return { ok: true }
  })
  handle('tasks.move', async (args) => service.moveTask(String(args.taskId), String(args.columnId) as 'todo'|'doing'|'review'|'done'))
  handle('tasks.comment', async (args) => service.addComment(String(args.taskId), String(args.content ?? ''), String(args.author ?? 'user'), typeof args.filePath === 'string' ? { filePath: args.filePath, lineNumber: typeof args.lineNumber === 'number' ? args.lineNumber : undefined } : undefined))
  handle('tasks.updateDescription', async (args) => service.updateDescription(String(args.taskId), String(args.description ?? ''), String(args.author ?? 'user')))
  handle('tasks.appendDetail', async (args) => service.appendDetail(String(args.taskId), String(args.content ?? ''), String(args.author ?? 'user')))
  handle('task.discuss', async (args) => service.startDiscussion(String(args.taskId)))

  handle('exec.dispatch', async (args) => {
    const rawRunner = typeof args.runner === 'object' && args.runner !== null ? args.runner as Record<string, unknown> : {}
    const runner = {
      ...(typeof rawRunner.mode === 'string' ? { mode: rawRunner.mode as 'agent' | 'api' } : {}),
      ...(typeof rawRunner.agentPreset === 'string' ? { agentPreset: rawRunner.agentPreset } : {}),
      ...(typeof rawRunner.provider === 'string' ? { provider: rawRunner.provider } : {}),
      ...(typeof rawRunner.model === 'string' ? { model: rawRunner.model } : {}),
      ...(typeof rawRunner.reasoningEffort === 'string' ? { reasoningEffort: rawRunner.reasoningEffort } : {}),
      ...(typeof rawRunner.maxTokens === 'number' ? { maxTokens: rawRunner.maxTokens } : {}),
    }
    const attempt = await service.dispatch(String(args.taskId), runner)
    return { attemptId: attempt.id, status: attempt.status }
  })
  handle('dispatch.catalog', async () => service.dispatchCatalog())
  handle('exec.stop', async (args) => {
    await service.stop(String(args.taskId))
    return { ok: true }
  })

  handle('review.diff', async (args) => service.getDiff(String(args.taskId)))
  handle('review.diffstat', async (args) => service.getDiffStat(String(args.taskId)))
  handle('review.merge', async (args) => {
    const result = await service.mergeTask(String(args.taskId), String(args.author ?? 'user'))
    return { taskId: result.task.id, commit: result.commit }
  })
  handle('review.revert', async (args) => {
    const result = await service.revertTask(String(args.taskId), String(args.reason ?? ''), String(args.author ?? 'user'))
    return { taskId: result.task.id, commit: result.commit }
  })
  handle('review.reject', async (args) => {
    const result = await service.rejectTask(String(args.taskId), String(args.reason ?? ''), String(args.author ?? 'user'))
    return { taskId: result.task.id, commit: result.commit }
  })
  handle('parse.tasks', async (args) => service.parseConversation({
    boardId: String(args.boardId ?? ''),
    text: typeof args.text === 'string' ? args.text : undefined,
    sessionId: typeof args.sessionId === 'string' ? args.sessionId : undefined,
    threadId: typeof args.threadId === 'string' ? args.threadId : undefined,
    dedupeSimilarity: typeof args.dedupeSimilarity === 'number' ? args.dedupeSimilarity : undefined,
    linkDependencies: typeof args.linkDependencies === 'boolean' ? args.linkDependencies : undefined,
  }))

  handle('state.snapshot', async () => service.snapshot())
}

export async function dispatchRpc(rpc: RpcRegistry, service: KanbanService, method: string, args: Record<string, unknown>): Promise<unknown> {
  const handler = rpc.handlers.get(method)
  if (!handler) throw new Error('unknown rpc method: ' + method)
  return handler(args, service)
}

export function createRpcHttpHandler(rpc: RpcRegistry, service: KanbanService) {
  return async (req: import('node:http').IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === 'GET' && req.url === '/herness-kanban/rpc') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'deepseek-herness-kanban', methods: [...rpc.handlers.keys()] }))
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    let body: RpcRequest
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }))
      return
    }
    try {
      const value = await dispatchRpc(rpc, service, String(body.method ?? ''), body.args ?? {})
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: message }))
    }
  }
}

export function createSseHandler(rpc: RpcRegistry) {
  return (_req: import('node:http').IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('data: {\"type\":\"hello\"}\n\n')
    rpc.sseClients.add(res)
    res.on('close', () => rpc.sseClients.delete(res))
  }
}

