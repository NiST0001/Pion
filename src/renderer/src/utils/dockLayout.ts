export const DOCK_PANELS = ['projects', 'chat', 'review', 'terminal'] as const
export type DockPanel = typeof DOCK_PANELS[number]
export const DOCK_LABELS: Record<DockPanel, string> = { projects: '项目', chat: '会话', review: '审查', terminal: '终端' }
export const DOCK_EDGES = ['left', 'right', 'top', 'bottom', 'center'] as const
export type DockEdge = typeof DOCK_EDGES[number]
export const DOCK_EDGE_LABELS: Record<DockEdge, string> = { left: '左侧', right: '右侧', top: '上方', bottom: '下方', center: '交换位置' }
export type DockNode = { type: 'panel'; panel: DockPanel } | {
  type: 'split'; axis: 'x' | 'y'; ratio: number; first: DockNode; second: DockNode
}
export interface DockLayout { version: 2; root: DockNode }
export interface DockRect { x: number; y: number; width: number; height: number }
export interface DockDivider { path: string; axis: 'x' | 'y'; ratio: number; rect: DockRect }
export const DOCK_STORAGE_KEY = 'pion:dock-layout-v2'
const LEGACY_KEY = 'pion:dock-layout-v1'
const leaf = (panel: DockPanel): DockNode => ({ type: 'panel', panel })
const split = (axis: 'x' | 'y', ratio: number, first: DockNode, second: DockNode): DockNode => ({ type: 'split', axis, ratio, first, second })
const clampRatio = (value: number) => Math.max(0.08, Math.min(0.92, value))
export function defaultDockLayout(): DockLayout {
  return { version: 2, root: split('x', 0.2, leaf('projects'),
    split('x', 0.68, split('y', 0.7, leaf('chat'), leaf('terminal')), leaf('review'))) }
}

export function normalizeDockLayout(value: unknown): DockLayout {
  const fallback = defaultDockLayout()
  if (!value || typeof value !== 'object') return fallback
  const input = value as Record<string, unknown>
  if (input.version === 2) {
    const seen = new Set<DockPanel>()
    const parse = (raw: unknown, depth: number): DockNode | null => {
      if (!raw || typeof raw !== 'object' || depth > 6) return null
      const node = raw as Record<string, unknown>
      if (node.type === 'panel' && DOCK_PANELS.includes(node.panel as DockPanel) && !seen.has(node.panel as DockPanel)) {
        seen.add(node.panel as DockPanel)
        return leaf(node.panel as DockPanel)
      }
      if (node.type !== 'split' || !['x', 'y'].includes(node.axis as string) || typeof node.ratio !== 'number' || !Number.isFinite(node.ratio)) return null
      const first = parse(node.first, depth + 1)
      const second = parse(node.second, depth + 1)
      return first && second ? split(node.axis as 'x' | 'y', clampRatio(node.ratio), first, second) : null
    }
    const root = parse(input.root, 0)
    return root && seen.size === DOCK_PANELS.length ? { version: 2, root } : fallback
  }
  // Migrate the old four-slot cache without silently losing the user's order.
  const slots = input.slots as Record<string, unknown> | undefined
  const names = ['left', 'center', 'right', 'bottom']
  if (!slots || !DOCK_PANELS.every((panel) => names.includes(slots[panel] as string)) || new Set(DOCK_PANELS.map((panel) => slots[panel])).size !== 4) return fallback
  const at = (slot: string) => leaf(DOCK_PANELS.find((panel) => slots[panel] === slot)!)
  const size = (key: string, otherwise: number) => {
    const value = input[key]
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(160, Math.min(900, value)) : otherwise
  }
  const left = Math.min(0.4, size('left', 240) / 1280)
  const right = Math.min(0.4, size('right', 420) / 1280)
  return { version: 2, root: split('y', clampRatio(1 - Math.min(0.7, size('bottom', 260) / 800)),
    split('x', left, at('left'), split('x', clampRatio(1 - right / (1 - left)), at('center'), at('right'))), at('bottom')) }
}

export function readDockLayout(): DockLayout {
  try {
    const value = localStorage.getItem(DOCK_STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY)
    return normalizeDockLayout(JSON.parse(value ?? 'null'))
  } catch { return defaultDockLayout() }
}

export function moveDockPanel(layout: DockLayout, panel: DockPanel, target: DockPanel, edge: DockEdge): DockLayout {
  if (panel === target) return layout
  if (edge === 'center') {
    const swap = (node: DockNode): DockNode => node.type === 'panel'
      ? leaf(node.panel === panel ? target : node.panel === target ? panel : node.panel)
      : { ...node, first: swap(node.first), second: swap(node.second) }
    return { version: 2, root: swap(layout.root) }
  }
  const remove = (node: DockNode): DockNode | null => {
    if (node.type === 'panel') return node.panel === panel ? null : node
    const first = remove(node.first), second = remove(node.second)
    return first && second ? { ...node, first, second } : first ?? second
  }
  const insert = (node: DockNode): DockNode => {
    if (node.type === 'panel') {
      if (node.panel !== target) return node
      const before = edge === 'left' || edge === 'top'
      return split(edge === 'left' || edge === 'right' ? 'x' : 'y', 0.5, before ? leaf(panel) : node, before ? node : leaf(panel))
    }
    return { ...node, first: insert(node.first), second: insert(node.second) }
  }
  return { version: 2, root: insert(remove(layout.root)!) }
}

export function resizeDockSplit(layout: DockLayout, path: string, ratio: number): DockLayout {
  if (!Number.isFinite(ratio)) return layout
  const visit = (node: DockNode, depth: number): DockNode => {
    if (node.type === 'panel') return node
    if (depth === path.length) return { ...node, ratio: clampRatio(ratio) }
    const child = path[depth] === '0' ? 'first' : 'second'
    return { ...node, [child]: visit(node[child], depth + 1) }
  }
  return { version: 2, root: visit(layout.root, 0) }
}

/** Project a split tree to rectangles. React renders panels in a fixed sibling
 * order; nesting changes geometry only, never component identity or PTY state. */
export function measureDockLayout(layout: DockLayout, visible: Record<DockPanel, boolean>) {
  const panels: Partial<Record<DockPanel, DockRect>> = {}
  const dividers: DockDivider[] = []
  const hasVisible = (node: DockNode): boolean => node.type === 'panel' ? visible[node.panel] : hasVisible(node.first) || hasVisible(node.second)
  const visit = (node: DockNode, rect: DockRect, path: string) => {
    if (node.type === 'panel') { if (visible[node.panel]) panels[node.panel] = rect; return }
    const first = hasVisible(node.first), second = hasVisible(node.second)
    if (!first && !second) return
    if (!first || !second) { visit(first ? node.first : node.second, rect, path + (first ? '0' : '1')); return }
    dividers.push({ path, axis: node.axis, ratio: node.ratio, rect })
    if (node.axis === 'x') {
      visit(node.first, { ...rect, width: rect.width * node.ratio }, path + '0')
      visit(node.second, { ...rect, x: rect.x + rect.width * node.ratio, width: rect.width * (1 - node.ratio) }, path + '1')
    } else {
      visit(node.first, { ...rect, height: rect.height * node.ratio }, path + '0')
      visit(node.second, { ...rect, y: rect.y + rect.height * node.ratio, height: rect.height * (1 - node.ratio) }, path + '1')
    }
  }
  visit(layout.root, { x: 0, y: 0, width: 1, height: 1 }, '')
  return { panels, dividers }
}

/** Prefer the nearest edge in normalized coordinates; the center swaps. */
export function dockEdgeAt(x: number, y: number): DockEdge {
  const distances: Array<[DockEdge, number]> = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]]
  const nearest = distances.reduce((best, item) => item[1] < best[1] ? item : best)
  return nearest[1] <= 0.26 ? nearest[0] : 'center'
}
