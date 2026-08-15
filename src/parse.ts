/**
 * Conversation → task decomposition (DC-01..DC-04).
 *
 * `herness_kanban_parse_conversation` hands the recent conversation to the
 * model through this prompt template; the result is validated into a task
 * list, de-duplicated against existing cards (DC-03), and created in batch
 * with the originating session/thread bound to each card (TM-09, DC-02).
 */
import type { Priority, Task } from './types.js'
import type { KanbanStore } from './store.js'

export const PARSE_SYSTEM_PROMPT = `You decompose a conversation into actionable kanban tasks.

Analyze the conversation the user provided. Extract every concrete piece of
work into independent, self-contained tasks. Follow these rules:

1. ONE task per piece of work; do not merge unrelated work.
2. Titles are short imperative lines (max 80 chars) in the conversation's
   language.
3. Descriptions carry the full context: goal, acceptance criteria, relevant
   files/functions mentioned, and any constraints the user stated.
4. Skip meta-requests, chit-chat, and anything already done.
5. Prefer small tasks (a task an agent can finish in one session).
6. Assign priority: critical = data loss/security/blocker, high = must have,
   medium = should have, low = nice to have.
7. Order tasks by dependency: foundational work first.
8. Where one task depends on another, record the dependency by the index of
   the prerequisite task (0-based), or null when independent.

Respond with STRICT JSON only — no markdown fences, no commentary:

{
  "tasks": [
    {
      "title": "string",
      "description": "string (markdown)",
      "priority": "low" | "medium" | "high" | "critical",
      "dependsOn": number | null
    }
  ]
}`

export interface ParsedTaskInput {
  title: string
  description: string
  priority: Priority
  dependsOn: number | null
}

export interface ParseResult {
  tasks: ParsedTaskInput[]
}

/** Validate and normalize the model's JSON into ParsedTaskInput[]. */
export function normalizeParseResult(raw: unknown): ParsedTaskInput[] {
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    try {
      return normalizeParseResult(JSON.parse(cleaned))
    } catch {
      throw new Error('parse_conversation: model returned invalid JSON')
    }
  }
  if (!raw || typeof raw !== 'object') throw new Error('parse_conversation: model returned no task list')
  const tasks = (raw as { tasks?: unknown }).tasks
  if (!Array.isArray(tasks)) throw new Error('parse_conversation: missing tasks array')
  const result: ParsedTaskInput[] = []
  for (const item of tasks) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    if (!title) continue
    const priority = entry.priority === 'low' || entry.priority === 'medium' || entry.priority === 'high' || entry.priority === 'critical' ? entry.priority : 'medium'
    const dependsOn = typeof entry.dependsOn === 'number' && Number.isInteger(entry.dependsOn) && (entry.dependsOn as number) >= 0 ? (entry.dependsOn as number) : null
    result.push({
      title: title.slice(0, 160),
      description: typeof entry.description === 'string' ? entry.description : '',
      priority,
      dependsOn,
    })
  }
  if (result.length === 0) throw new Error('parse_conversation: model produced no usable tasks')
  return result
}

export interface CreateParsedTasksInput {
  boardId: string
  tasks: ParsedTaskInput[]
  sessionId?: string
  threadId?: string
  /** DC-03: skip tasks whose title is ≥ threshold similar to an existing card. */
  dedupeSimilarity?: number
  /** When true, dependencies become parent/subtask links (DC-04). */
  linkDependencies?: boolean
}

export interface CreateParsedTasksResult {
  created: Task[]
  skippedDuplicates: number
  dependencyLinked: number
}

function similarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim()
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const tokensA = new Set(na.split(' ').filter(Boolean))
  const tokensB = nb.split(' ').filter(Boolean)
  if (tokensA.size === 0) return 0
  let overlap = 0
  for (const token of tokensB) if (tokensA.has(token)) overlap++
  return overlap / Math.max(tokensA.size, tokensB.length)
}

/**
 * DC-01/DC-02: batch-create tasks from a parsed conversation, binding each
 * card to the originating session and thread (TM-09).
 */
export async function createParsedTasks(store: KanbanStore, input: CreateParsedTasksInput): Promise<CreateParsedTasksResult> {
  const existing = store.listTasks(input.boardId)
  const threshold = input.dedupeSimilarity ?? 0.85
  const idByIndex = new Map<number, string>()
  const created: Task[] = []
  let skipped = 0
  let linked = 0

  for (let index = 0; index < input.tasks.length; index++) {
    const parsed = input.tasks[index]!
    const duplicate = existing.some((t) => t.columnId !== 'done' && similarity(t.title, parsed.title) >= threshold)
    if (duplicate) {
      skipped++
      continue
    }
    const dependsOn = parsed.dependsOn === null ? undefined : idByIndex.get(parsed.dependsOn)
    const task = await store.createTask({
      boardId: input.boardId,
      title: parsed.title,
      description: parsed.description,
      priority: parsed.priority,
      sessionId: input.sessionId,
      threadId: input.threadId,
      parentTaskId: input.linkDependencies && dependsOn ? dependsOn : undefined,
    })
    idByIndex.set(index, task.id)
    created.push(task)
    if (task.parentTaskId) linked++
    existing.push(task)
  }

  return { created, skippedDuplicates: skipped, dependencyLinked: linked }
}

/** Render a conversation for the parse prompt (latest turns first, capped). */
export function summarizeConversationForParsing(messages: Array<{ role: string; content: string }>, maxTurns = 40): string {
  const turns = messages.slice(-maxTurns)
  return turns.map((m) => (m.role === 'user' ? '👤 User' : '🤖 Assistant') + ': ' + m.content.slice(0, 4000)).join('\n\n')
}
