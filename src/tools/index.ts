/**
 * All 17 agent tools, prefixed herness_kanban_ (DS-01):
 *
 * boards  : list_boards, create_board, delete_board                        (3)
 * tasks   : list_tasks, get_task, create_task, update_task, delete_task,
 *           move_task, add_comment, update_description                      (8)
 * exec    : dispatch_task, stop_task, get_diff, merge_task, revert_task,
 *           parse_conversation                                              (6)
 */
import type { KanbanService } from '../service.js'
import { registerBoardTools } from './boards.js'
import { registerTaskTools } from './tasks.js'
import { registerExecutionTools } from './execution.js'

export interface ToolRegistrar {
  tools: { register(definition: unknown): () => void }
}

export const TOOL_NAMES = [
  'herness_kanban_list_boards',
  'herness_kanban_create_board',
  'herness_kanban_delete_board',
  'herness_kanban_list_tasks',
  'herness_kanban_get_task',
  'herness_kanban_create_task',
  'herness_kanban_update_task',
  'herness_kanban_delete_task',
  'herness_kanban_move_task',
  'herness_kanban_add_comment',
  'herness_kanban_update_description',
  'herness_kanban_dispatch_task',
  'herness_kanban_stop_task',
  'herness_kanban_merge_task',
  'herness_kanban_get_diff',
  'herness_kanban_revert_task',
  'herness_kanban_parse_conversation',
] as const

export function registerTools(ctx: ToolRegistrar, service: KanbanService): Array<() => void> {
  const disposers: Array<() => void> = []
  const registrar = {
    tools: {
      register(definition: unknown) {
        const disposer = ctx.tools.register(definition)
        disposers.push(disposer)
        return disposer
      },
    },
  }
  registerBoardTools(registrar, service)
  registerTaskTools(registrar, service)
  registerExecutionTools(registrar, service)
  return disposers
}
