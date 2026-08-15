/**
 * Client-plane plugin entry (DS-03): registers the 📋 board overlay and the
 * sidebar footer toggle with the DSH slot system.
 *
 * The host serves this bundle at /plugins/deepseek-herness-kanban/client.js
 * (declared via exports[\"./client\"] + dsh.client in package.json).
 */
import { connectEvents } from './api'
import { KanbanFooterButton, KanbanOverlay } from './Board'

interface SlotsRegistry {
  inject(key: string, register: () => void): void
  register(options: unknown, component: unknown): () => void
}

interface ClientContext {
  slots: SlotsRegistry
  locale?: { register(namespace: string, dict: Record<string, unknown>): () => void }
  effect(cb: () => (() => void) | void, label?: string): unknown
}

export const inject = ['slots', 'locale']

const NS = 'herness-kanban'

const dict = {
  en: { 'board.toggle': 'Kanban', 'board.title': 'Kanban Board' },
  zh: { 'board.toggle': '看板', 'board.title': '看板' },
}

export function apply(ctx: ClientContext) {
  // SSE / polling for live updates (NF-12)
  ctx.effect(() => connectEvents(), 'herness-kanban: events')

  ctx.effect(() => ctx.locale?.register(NS, dict) ?? (() => {}), 'herness-kanban: locale')

  // full-frame board surface
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: NS,
    locale: NS,
    inject: () => ({}),
  }, KanbanOverlay)), 'herness-kanban: overlay registration')

  // sidebar footer toggle
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: NS,
    locale: NS,
    inject: () => ({}),
  }, KanbanFooterButton)), 'herness-kanban: footer toggle registration')
}

