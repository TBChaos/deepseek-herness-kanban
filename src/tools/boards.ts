/**
 * Board tools: herness_kanban_list_boards / create_board / delete_board.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { KanbanService } from '../service.js'

const boardOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    repoPath: { type: 'string', required: true },
    mainBranch: { type: 'string', required: true },
  },
} as const

const boardsOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    boards: { type: 'array', required: true, items: boardOutputSchema },
  },
} as const

export function registerBoardTools(ctx: { tools: { register(definition: unknown): () => void } }, service: KanbanService) {
  ctx.tools.register(defineTool({
    name: 'herness_kanban_list_boards',
    description: 'List all kanban boards. Each board maps to one Git repository and a 4-column workflow (todo → doing → review → done).',
    parameters: {},
    output: {
      schema: boardsOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: value.boards.length === 0
          ? 'No boards yet. Create one with herness_kanban_create_board.'
          : value.boards.map((b: { id: string; name: string; repoPath: string; mainBranch: string }) => b.id + ' · ' + b.name + ' @ ' + b.repoPath + ' (' + b.mainBranch + ')').join('\n'),
      }],
    },
    execute: async () => {
      const boards = service.listBoards()
      return {
        boards: boards.map((b) => ({ id: b.id, name: b.name, repoPath: b.repoPath, mainBranch: b.mainBranch })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List kanban boards', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_create_board',
    description: 'Create a new kanban board for a local Git repository. The path is auto-detected as a repo, or git init is run when it does not exist. The board gets the standard 4 columns.',
    parameters: {
      name: { type: 'string', required: true, description: 'Human-readable board name.' },
      repoPath: { type: 'string', required: true, description: 'Absolute local path of the Git repository to manage.' },
      description: { type: 'string', description: 'Optional board description.' },
      mainBranch: { type: 'string', description: 'Main branch name; auto-detected when omitted.' },
    },
    output: {
      schema: boardOutputSchema,
      render: (_args, value) => [{ type: 'text', text: 'Board created: ' + value.id + ' · ' + value.name + ' @ ' + value.repoPath }],
    },
    execute: async (args) => {
      const board = await service.createBoard({
        name: args.name,
        description: args.description,
        repoPath: args.repoPath,
        mainBranch: args.mainBranch,
      })
      return { id: board.id, name: board.name, repoPath: board.repoPath, mainBranch: board.mainBranch }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Create board', kind: 'other', rawInput: { name: args.name, repoPath: args.repoPath } }),
  }))

  ctx.tools.register(defineTool({
    name: 'herness_kanban_delete_board',
    description: 'Delete a kanban board and all of its task cards. Running tasks must be stopped first. Does NOT touch the Git repository itself.',
    parameters: {
      boardId: { type: 'string', required: true, description: 'Board id from herness_kanban_list_boards.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'boolean', required: true }, boardId: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: 'Board deleted: ' + value.boardId }],
    },
    execute: async (args) => {
      await service.deleteBoard(args.boardId)
      return { deleted: true, boardId: args.boardId }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Delete board', kind: 'other', rawInput: { boardId: args.boardId } }),
  }))
}
