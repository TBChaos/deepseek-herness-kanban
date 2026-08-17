/**
 * Tool output regression tests: every tool result must survive the harness's
 * lossless-JSON snapshot validation (no `undefined` properties) and stay
 * within the declared output schema.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { registerTaskTools } from '../src/tools/tasks.js'
import type { Task } from '../src/types.js'

const task: Task = {
  id: 'task-demo-1',
  boardId: 'board-demo-1',
  title: 'demo task',
  description: 'do the thing',
  priority: 'medium',
  columnId: 'todo',
  createdAt: 1,
  updatedAt: 2,
  attempts: [{
    id: 'attempt-1',
    taskId: 'task-demo-1',
    status: 'failed',
    startedAt: 1,
    finishedAt: 2,
    error: 'boom',
    progressLogs: ['line'],
  }],
  comments: [{ id: 'comment-1', taskId: 'task-demo-1', author: 'agent', content: 'note', createdAt: 1 }],
  events: [
    { id: 'event-1', taskId: 'task-demo-1', type: 'created' as const, data: {}, timestamp: 1 },
    { id: 'event-2', taskId: 'task-demo-1', type: 'failed' as const, data: { attemptId: 'attempt-1' }, timestamp: 2 },
  ],
}

type ToolDef = {
  name: string
  output: { schema: Record<string, any> }
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>
}

function harness() {
  const defs = new Map<string, ToolDef>()
  const ctx = { tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } } }
  const service = {
    listTasks: () => [task],
    getTask: (id: string) => {
      if (id !== task.id) throw new Error('not found: ' + id)
      return task
    },
    createTask: async () => task,
    updateTask: async () => task,
    moveTask: async () => task,
    updateDescription: async () => task,
    addComment: async () => task.comments[0],
    deleteTask: async () => undefined,
  }
  registerTaskTools(ctx as never, service as never)
  return defs
}

function declaredKeys(schema: Record<string, any>): Set<string> {
  return new Set(Object.keys(schema.properties ?? {}))
}

describe('task tool outputs', () => {
  it('list_tasks returns lossless JSON even with unset optional fields', async () => {
    const defs = harness()
    const def = defs.get('herness_kanban_list_tasks')
    assert.ok(def)
    const value = await def.execute({ boardId: 'board-demo-1' })
    assert.notEqual(snapshotJsonValue(value), undefined)
  })

  it('get_task returns lossless JSON whose fields are all declared', async () => {
    const defs = harness()
    const def = defs.get('herness_kanban_get_task')
    assert.ok(def)
    const value = await def.execute({ taskId: 'task-demo-1' })
    assert.notEqual(snapshotJsonValue(value), undefined)

    const taskSchema = def.output.schema.properties.task
    const taskValue = (value as { task: Record<string, any> }).task
    const taskKeys = declaredKeys(taskSchema)
    for (const key of Object.keys(taskValue)) {
      assert.ok(taskKeys.has(key), 'task.' + key + ' is not declared in the output schema')
    }

    const attemptKeys = declaredKeys(taskSchema.properties.attempts.items)
    for (const key of Object.keys(taskValue.attempts[0])) {
      assert.ok(attemptKeys.has(key), 'task.attempts[].' + key + ' is not declared in the output schema')
    }
    const eventKeys = declaredKeys(taskSchema.properties.events.items)
    for (const key of Object.keys(taskValue.events[0])) {
      assert.ok(eventKeys.has(key), 'task.events[].' + key + ' is not declared in the output schema')
    }
    const commentKeys = declaredKeys(taskSchema.properties.comments.items)
    for (const key of Object.keys(taskValue.comments[0])) {
      assert.ok(commentKeys.has(key), 'task.comments[].' + key + ' is not declared in the output schema')
    }
  })

  it('create_task / update_task / move_task digests stay lossless', async () => {
    const defs = harness()
    for (const name of ['herness_kanban_create_task', 'herness_kanban_update_task', 'herness_kanban_move_task', 'herness_kanban_update_description']) {
      const def = defs.get(name)
      assert.ok(def, name + ' registered')
      const args = name.includes('create')
        ? { boardId: 'board-demo-1', title: 't' }
        : name.includes('update_description')
          ? { taskId: 'task-demo-1', description: 'new description' }
          : { taskId: 'task-demo-1', ...(name.includes('move') ? { columnId: 'doing' } : {}) }
      const value = await def.execute(args, {})
      assert.notEqual(snapshotJsonValue(value), undefined, name + ' output is not lossless JSON')
    }
  })
})
