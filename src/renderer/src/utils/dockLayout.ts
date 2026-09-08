export const DOCK_PANELS = ['projects', 'chat', 'review', 'terminal'] as const
export const DOCK_SLOTS = ['left', 'center', 'right', 'bottom'] as const
export type DockPanel = typeof DOCK_PANELS[number]
export type DockSlot = typeof DOCK_SLOTS[number]
export interface DockLayout {
  slots: Record<DockPanel, DockSlot>
  left: number
  right: number
  bottom: number
}
export const DEFAULT_DOCK_LAYOUT: DockLayout = {
  slots: { projects: 'left', chat: 'center', review: 'right', terminal: 'bottom' },
  left: 240, right: 420, bottom: 260
}
export const DOCK_STORAGE_KEY = 'pion:dock-layout-v1'

export function normalizeDockLayout(value: unknown): DockLayout {
  const fallback = { ...DEFAULT_DOCK_LAYOUT, slots: { ...DEFAULT_DOCK_LAYOUT.slots } }
  if (!value || typeof value !== 'object') return fallback
  const candidate = value as Partial<DockLayout>
  const slots = candidate.slots
  if (slots && DOCK_PANELS.every((panel) => DOCK_SLOTS.includes(slots[panel]))
    && new Set(DOCK_PANELS.map((panel) => slots[panel])).size === 4) fallback.slots = { ...slots }
  for (const key of ['left', 'right', 'bottom'] as const) {
    const size = candidate[key]
    if (typeof size === 'number' && Number.isFinite(size)) fallback[key] = Math.max(160, Math.min(900, size))
  }
  return fallback
}

export function moveDockPanel(layout: DockLayout, panel: DockPanel, target: DockSlot): DockLayout {
  const displaced = DOCK_PANELS.find((key) => layout.slots[key] === target)!
  return { ...layout, slots: { ...layout.slots, [panel]: target, [displaced]: layout.slots[panel] } }
}

export function readDockLayout(): DockLayout {
  try { return normalizeDockLayout(JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? 'null')) }
  catch { return normalizeDockLayout(null) }
}
