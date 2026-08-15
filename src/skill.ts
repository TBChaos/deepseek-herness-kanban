import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-skill'

const FALLBACK_CONTENT = [
  '# herness-kanban',
  '',
  'Use the herness_kanban_* tools to manage the kanban board. Cards live in 4',
  'columns (todo → doing → review → done). Dispatch cards into isolated Git',
  'worktrees, review their diffs, and merge only after human approval. Turn the',
  'current conversation into tasks with herness_kanban_parse_conversation.',
  '',
].join('\n')

export const SKILL_NAME = 'herness-kanban'

export const SKILL_DESCRIPTION = 'Operate the deepseek-herness-kanban board: create and update cards, dispatch work into isolated Git worktrees, review diffs, merge or revert, and decompose the current conversation into tasks. Load this skill when the user asks about the kanban board, task cards, dispatching work, code review of an agent changes, or turning a discussion into tasks.'

export function loadSkillContent(): string {
  try {
    const path = fileURLToPath(new URL('../skill/SKILL.md', import.meta.url))
    return readFileSync(path, 'utf8')
  } catch {
    return FALLBACK_CONTENT
  }
}

export function registerSkill(ctx: { skills: { register(skill: unknown): () => void } }): () => void {
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    content: loadSkillContent(),
    source: 'bundled',
    provider: 'deepseek-herness-kanban',
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
