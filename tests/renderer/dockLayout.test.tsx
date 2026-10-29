// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useEffect } from 'react'
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DOCK_PANELS, DOCK_LABELS, DOCK_EDGES, DOCK_STORAGE_KEY, defaultDockLayout, dockEdgeAt, measureDockLayout, moveDockPanel, normalizeDockLayout, readDockLayout, resizeDockSplit } from '../../src/renderer/src/utils/dockLayout'
import { useDockLayout } from '../../src/renderer/src/hooks/useDockLayout'
import { DockHeader } from '../../src/renderer/src/features/chrome/DockHeader'
import type { DockLayout, DockNode, DockPanel } from '../../src/renderer/src/utils/dockLayout'

const visible: Record<DockPanel, boolean> = { projects: true, chat: true, review: true, terminal: true, browser: false, gitCommitTree: false }
const browserVisible = { ...visible, browser: true }
const allVisible = { ...browserVisible, gitCommitTree: true }
const panelNode = (panel: DockPanel): DockNode => ({ type: 'panel', panel })
const splitNode = (axis: 'x' | 'y', ratio: number, first: DockNode, second: DockNode): DockNode => ({ type: 'split', axis, ratio, first, second })
const oldDefault: DockLayout = { version: 2, root: splitNode('x', 0.2, panelNode('projects'),
  splitNode('x', 0.68, splitNode('y', 0.7, panelNode('chat'), panelNode('terminal')), panelNode('review'))) }
const oldFiveDefault: DockLayout = { version: 2, root: splitNode('x', 0.2, panelNode('projects'),
  splitNode('x', 0.68, splitNode('y', 0.7, splitNode('x', 0.6, panelNode('chat'), panelNode('browser')), panelNode('terminal')), panelNode('review'))) }
const leaves = (node: DockNode): DockPanel[] => node.type === 'panel' ? [node.panel] : [...leaves(node.first), ...leaves(node.second)]
beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.useRealTimers() })

function resizeFixture() {
  vi.useFakeTimers()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++frameId, callback); return frameId })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
  const saved = vi.spyOn(Storage.prototype, 'setItem')
  const hook = renderHook(() => useDockLayout(visible))
  const root = document.createElement('div')
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 800))
  hook.result.current.rootRef.current = root
  const begin = (path = '', clientX = 200, clientY = 0) => act(() => {
    const divider = hook.result.current.dividers.find((item) => item.path === path)!
    hook.result.current.dividerProps(divider).onPointerDown({ button: 0, pointerId: 1, clientX, clientY,
      currentTarget: root, preventDefault: vi.fn() } as unknown as ReactPointerEvent<HTMLDivElement>)
  })
  const pointer = (type: string, clientX: number, clientY = 0, pointerId = 1) => act(() => {
    const event = new MouseEvent(type, { clientX, clientY })
    Object.defineProperty(event, 'pointerId', { value: pointerId })
    window.dispatchEvent(event)
  })
  const frame = () => act(() => {
    const batch = [...frames.values()]
    frames.clear()
    batch.forEach((callback) => callback(0))
  })
  return { ...hook, saved, frames, begin, pointer, frame }
}

it('supports nested docking beside or beneath any panel rather than four fixed slots', () => {
  const beside = moveDockPanel(defaultDockLayout(), 'terminal', 'review', 'right')
  const nested = moveDockPanel(beside, 'chat', 'review', 'bottom')
  const panels = measureDockLayout(nested, visible).panels
  expect(panels.terminal!.height).toBe(1)
  expect(panels.review!.x).toBe(panels.chat!.x)
  expect(panels.review!.y).toBeLessThan(panels.chat!.y)
  expect(panels.chat!.x).toBeLessThan(panels.terminal!.x)
  expect(panels.chat!.width).toBeLessThan(1)
  expect(normalizeDockLayout(nested)).toEqual(nested)
})

it('never loses or duplicates panels across repeated edge moves and swaps', () => {
  let layout = defaultDockLayout()
  for (const source of DOCK_PANELS) for (const target of DOCK_PANELS) for (const edge of DOCK_EDGES) {
    layout = moveDockPanel(layout, source, target, edge)
    expect(leaves(layout.root).sort()).toEqual([...DOCK_PANELS].sort())
    expect(normalizeDockLayout(layout)).toEqual(layout)
    const rects = Object.values(measureDockLayout(layout, allVisible).panels)
    expect(rects).toHaveLength(6)
    expect(rects.reduce((area, rect) => area + rect.width * rect.height, 0)).toBeCloseTo(1)
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j]
      const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
        * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
      expect(overlap).toBeLessThan(1e-9)
    }
  }
})

it('resizes individual splits and collapses hidden branches without modifying saved structure', () => {
  const layout = resizeDockSplit(defaultDockLayout(), '10', 0.3)
  expect(measureDockLayout(layout, visible).panels.chat!.height).toBeCloseTo(0.3)
  const hidden = measureDockLayout(layout, { ...visible, terminal: false })
  expect(hidden.panels.chat!.height).toBe(1)
  expect(hidden.dividers.some((divider) => divider.path === '10')).toBe(false)
  expect(measureDockLayout(layout, visible).panels.chat!.height).toBeCloseTo(0.3)
  const solo = measureDockLayout(layout, { projects: false, chat: true, review: false, terminal: false, browser: false, gitCommitTree: false })
  expect(solo.panels.chat).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  expect(solo.dividers).toEqual([])
})

it('migrates v1 positions and rejects malformed, duplicate or non-finite trees', () => {
  const legacy = { slots: { projects: 'right', chat: 'center', review: 'left', terminal: 'bottom' }, left: 240, right: 420, bottom: 260 }
  localStorage.setItem('pion:dock-layout-v1', JSON.stringify(legacy))
  const migrated = readDockLayout()
  const panels = measureDockLayout(migrated, visible).panels
  expect(panels.review!.x).toBe(0)
  expect(panels.projects!.x).toBeGreaterThan(panels.chat!.x)
  expect(panels.terminal!.width).toBe(1)
  localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(migrated))
  expect(readDockLayout()).toEqual(migrated)
  const invalid = { version: 2, root: { type: 'split', axis: 'x', ratio: 0.5, first: { type: 'panel', panel: 'chat' }, second: { type: 'panel', panel: 'chat' } } }
  expect(normalizeDockLayout(invalid)).toEqual(defaultDockLayout())
  expect(normalizeDockLayout({ version: 2, root: { ...invalid.root, ratio: NaN } })).toEqual(defaultDockLayout())
  localStorage.setItem(DOCK_STORAGE_KEY, '{broken')
  expect(readDockLayout()).toEqual(defaultDockLayout())
})

it('keeps default four/five-panel geometry and adds GitCommitTree beneath chat', () => {
  const layout = defaultDockLayout()
  expect(DOCK_LABELS.browser).toBe('浏览器')
  expect(DOCK_LABELS.gitCommitTree).toBe('提交图')
  expect(DOCK_PANELS.at(-1)).toBe('gitCommitTree')
  expect(DOCK_STORAGE_KEY).toBe('pion:dock-layout-v2')
  expect(measureDockLayout(layout, visible)).toEqual(measureDockLayout(oldDefault, visible))
  expect(measureDockLayout(layout, browserVisible)).toEqual(measureDockLayout(oldFiveDefault, browserVisible))
  const panels = measureDockLayout(layout, browserVisible).panels
  expect(panels.browser!.x).toBeCloseTo(panels.chat!.x + panels.chat!.width)
  expect(panels.browser!.y).toBe(panels.chat!.y)
  expect(panels.browser!.height).toBe(panels.chat!.height)
  const withTree = measureDockLayout(layout, allVisible).panels
  expect(withTree.gitCommitTree!.x).toBe(withTree.chat!.x)
  expect(withTree.gitCommitTree!.width).toBe(withTree.chat!.width)
  expect(withTree.gitCommitTree!.y).toBeCloseTo(withTree.chat!.y + withTree.chat!.height)
  expect(withTree.chat!.height / (withTree.chat!.height + withTree.gitCommitTree!.height)).toBeCloseTo(0.6)
  localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(layout))
  expect(readDockLayout()).toEqual(layout)
})

it('migrates valid v2 trees without changing old ratios, order or hidden-browser geometry', () => {
  const oldLayouts: DockLayout[] = [oldDefault, { version: 2, root: splitNode('y', 0.31,
    panelNode('terminal'), splitNode('x', 0.47, panelNode('review'),
      splitNode('y', 0.83, panelNode('projects'), panelNode('chat')))) }]
  for (const old of oldLayouts) {
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(old))
    const migrated = readDockLayout()
    const removeAdditions = (node: DockNode): DockNode => {
      if (node.type === 'panel') return node
      if (node.second.type === 'panel' && ['browser', 'gitCommitTree'].includes(node.second.panel)) return removeAdditions(node.first)
      return { ...node, first: removeAdditions(node.first), second: removeAdditions(node.second) }
    }
    expect(removeAdditions(migrated.root)).toEqual(old.root)
    expect(leaves(migrated.root).sort()).toEqual([...DOCK_PANELS].sort())
    for (let mask = 0; mask < 16; mask++) {
      const visibility = { projects: !!(mask & 1), chat: !!(mask & 2), review: !!(mask & 4), terminal: !!(mask & 8), browser: false, gitCommitTree: false }
      expect(measureDockLayout(migrated, visibility)).toEqual(measureDockLayout(old, visibility))
    }
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(migrated))
    expect(readDockLayout()).toEqual(migrated)
  }
})

it('migrates five-panel v2 trees with identical geometry and divider paths when GitCommitTree is hidden', () => {
  const oldLayouts: DockLayout[] = [oldFiveDefault, { version: 2, root: splitNode('y', 0.31,
    panelNode('browser'), splitNode('x', 0.47, panelNode('review'), splitNode('y', 0.83,
      panelNode('projects'), splitNode('x', 0.64, panelNode('terminal'), panelNode('chat'))))) }]
  for (const old of oldLayouts) {
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(old))
    const migrated = readDockLayout()
    expect(leaves(migrated.root).sort()).toEqual([...DOCK_PANELS].sort())
    for (let mask = 0; mask < 32; mask++) {
      const visibility = { projects: !!(mask & 1), chat: !!(mask & 2), review: !!(mask & 4), terminal: !!(mask & 8), browser: !!(mask & 16), gitCommitTree: false }
      expect(measureDockLayout(migrated, visibility)).toEqual(measureDockLayout(old, visibility))
    }
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(migrated))
    expect(readDockLayout()).toEqual(migrated)
  }
})

it('migrates the independent v1 four-slot list with chat in any slot', () => {
  const oldPanels = ['projects', 'chat', 'review', 'terminal'] as const
  const names = ['left', 'center', 'right', 'bottom']
  for (let offset = 0; offset < 4; offset++) {
    const slots = Object.fromEntries(oldPanels.map((panel, index) => [panel, names[(index + offset) % 4]]))
    const at = (slot: string) => panelNode(oldPanels.find((panel) => slots[panel] === slot)!)
    const old: DockLayout = { version: 2, root: splitNode('y', 0.675,
      splitNode('x', 0.1875, at('left'), splitNode('x', 1 - (420 / 1280) / (1 - 0.1875), at('center'), at('right'))), at('bottom')) }
    for (const version of [undefined, 1]) {
      const migrated = normalizeDockLayout({ version, slots, left: 240, right: 420, bottom: 260 })
      expect(leaves(migrated.root).sort()).toEqual([...DOCK_PANELS].sort())
      expect(measureDockLayout(migrated, visible)).toEqual(measureDockLayout(old, visible))
    }
  }
  expect(normalizeDockLayout({ version: 1, slots: { projects: 'left', chat: 'center', review: 'right' } })).toEqual(defaultDockLayout())
  expect(normalizeDockLayout({ version: 1, slots: { projects: 'left', chat: 'center', review: 'right', terminal: 'right' } })).toEqual(defaultDockLayout())
  expect(normalizeDockLayout({ version: 3, slots: { projects: 'left', chat: 'center', review: 'right', terminal: 'bottom' } })).toEqual(defaultDockLayout())
})

it('accepts maximal six-panel nesting but rejects missing panels, duplicates and damaged depth', () => {
  const deepest: DockLayout = { version: 2, root: splitNode('y', 0.4, panelNode('projects'),
    splitNode('x', 0.3, panelNode('review'), splitNode('y', 0.2, panelNode('terminal'),
      splitNode('x', 0.6, splitNode('y', 0.6, panelNode('chat'), panelNode('gitCommitTree')), panelNode('browser'))))) }
  expect(normalizeDockLayout(deepest)).toEqual(deepest)
  for (const missing of ['projects', 'chat', 'review', 'terminal'] as const) {
    const replace = (node: DockNode): DockNode => node.type === 'panel'
      ? panelNode(node.panel === missing ? 'browser' : node.panel)
      : { ...node, first: replace(node.first), second: replace(node.second) }
    expect(normalizeDockLayout({ version: 2, root: replace(oldDefault.root) })).toEqual(defaultDockLayout())
    expect(normalizeDockLayout({ version: 2, root: replace(deepest.root) })).toEqual(defaultDockLayout())
  }
  let damaged: DockNode = deepest.root
  for (let depth = 0; depth < 12; depth++) damaged = splitNode('x', 0.5, damaged, panelNode('chat'))
  expect(normalizeDockLayout({ version: 2, root: damaged })).toEqual(defaultDockLayout())
  const cyclic = splitNode('x', 0.5, panelNode('chat'), panelNode('browser'))
  if (cyclic.type === 'split') cyclic.first = cyclic
  expect(normalizeDockLayout({ version: 2, root: cyclic })).toEqual(defaultDockLayout())
  localStorage.setItem('pion:dock-layout-v1', JSON.stringify({ slots: { projects: 'right', chat: 'center', review: 'left', terminal: 'bottom' } }))
  localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ version: 2, root: damaged }))
  expect(readDockLayout()).toEqual(defaultDockLayout())
})

it('maps all four edges and the center independently', () => {
  expect(dockEdgeAt(0.05, 0.5)).toBe('left')
  expect(dockEdgeAt(0.95, 0.5)).toBe('right')
  expect(dockEdgeAt(0.5, 0.05)).toBe('top')
  expect(dockEdgeAt(0.5, 0.95)).toBe('bottom')
  expect(dockEdgeAt(0.5, 0.5)).toBe('center')
})

it('previews the final split geometry and changes layout only on a valid drop', () => {
  const { result } = renderHook(() => useDockLayout(visible))
  const initial = result.current.layout
  const transfer = { types: ['application/x-pion-dock-panel'], setData: vi.fn(), getData: () => 'terminal', effectAllowed: '', dropEffect: '' }
  const event = { dataTransfer: transfer, stopPropagation: vi.fn(), preventDefault: vi.fn(), clientX: 490, clientY: 300,
    currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 100, width: 400, height: 400 }) } } as unknown as DragEvent<HTMLElement>
  act(() => result.current.panelProps('review').onDrop(event))
  expect(result.current.layout).toBe(initial) // foreign drag has no active panel
  act(() => result.current.dragProps('terminal').onDragStart(event))
  act(() => result.current.panelProps('review').onDragOver(event))
  expect(result.current.drop).toEqual({ panel: 'review', edge: 'right' })
  expect(result.current.previewStyle).toBeDefined()
  expect(result.current.layout).toBe(initial)
  act(() => result.current.panelProps('review').onDrop(event))
  const panels = measureDockLayout(result.current.layout, visible).panels
  expect(panels.terminal!.x).toBeGreaterThan(panels.review!.x)
  expect(result.current.dragged).toBeNull()
  expect(result.current.previewStyle).toBeUndefined()
})

it('coalesces pointer moves into one frame and saves the final pointerup position', () => {
  const h = resizeFixture()
  const initial = h.result.current.layout
  h.begin()
  h.pointer('pointermove', 300)
  h.pointer('pointermove', 400)
  h.pointer('pointermove', 900, 0, 2)
  h.pointer('pointerup', 900, 0, 2)
  expect(h.result.current.layout).toBe(initial)
  expect(h.frames.size).toBe(1)
  expect(h.saved).not.toHaveBeenCalled()
  h.frame()
  expect(h.result.current.layout).toEqual(resizeDockSplit(initial, '', 0.4))
  expect(h.saved).not.toHaveBeenCalled()
  h.pointer('pointermove', 420)
  h.pointer('pointerup', 470)
  expect(measureDockLayout(h.result.current.layout, visible).panels.projects!.width).toBeCloseTo(0.47)
  expect(h.saved).toHaveBeenCalledTimes(1)
  expect(readDockLayout()).toEqual(h.result.current.layout)
  expect(h.frames.size).toBe(0)
  expect(document.body).not.toHaveClass('pion-resizing-panels')
  act(() => vi.advanceTimersByTime(1000))
  expect(h.saved).toHaveBeenCalledTimes(1)
})

it('flushes the last captured coordinates on Escape and rejects the retired frame', () => {
  const h = resizeFixture()
  const initial = h.result.current.layout
  h.begin()
  h.pointer('pointermove', 400)
  const late = [...h.frames.values()][0]
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  const settled = h.result.current.layout
  expect(settled).toEqual(resizeDockSplit(initial, '', 0.4))
  expect(readDockLayout()).toEqual(settled)
  expect(h.saved).toHaveBeenCalledTimes(1)
  expect(h.frames.size).toBe(0)
  // Drain JSDOM's 0ms storage event; a leaked 250ms dock save must remain visible.
  act(() => vi.advanceTimersByTime(0))
  expect(vi.getTimerCount()).toBe(0)
  expect(document.body).not.toHaveClass('pion-resizing-panels')
  act(() => late(0))
  h.pointer('pointermove', 600)
  expect(h.result.current.layout).toBe(settled)
})

it('uses the nested span and last captured move when pointercancel has zero coordinates', () => {
  const h = resizeFixture()
  h.begin('10', 0, 560)
  h.pointer('pointermove', 0, 640)
  h.pointer('pointercancel', 0, 0)
  expect(measureDockLayout(h.result.current.layout, visible).panels.chat!.height).toBeCloseTo(0.8)
  expect(readDockLayout()).toEqual(h.result.current.layout)
  expect(h.frames.size).toBe(0)
  expect(document.body).not.toHaveClass('pion-resizing-panels')
})

it.each(['reset', 'move'] as const)('retires a queued resize before %s and rejects its late callback during a new drag', (operation) => {
  const h = resizeFixture()
  h.begin()
  h.pointer('pointermove', 400)
  const late = [...h.frames.values()][0]
  act(() => operation === 'reset' ? h.result.current.reset() : h.result.current.movePanel('terminal', 'review', 'right'))
  const replacement = h.result.current.layout
  h.begin()
  h.pointer('pointermove', 300)
  act(() => late(0))
  expect(h.result.current.layout).toBe(replacement)
  h.frame()
  expect(h.result.current.layout).toEqual(resizeDockSplit(replacement, '', (replacement.root as { ratio: number }).ratio + 0.1))
  h.pointer('pointercancel', 0)
  expect(readDockLayout()).toEqual(h.result.current.layout)
})

it('bounds the save tail during repeated keyboard input and skips unchanged clamped drag frames', () => {
  const h = resizeFixture()
  const resize = h.result.current.dividerProps(h.result.current.dividers[0]).onKeyDown
  const key = { key: 'ArrowRight', preventDefault: vi.fn() } as unknown as ReactKeyboardEvent<HTMLDivElement>
  act(() => { resize(key); resize(key); vi.advanceTimersByTime(200); resize(key) })
  expect(h.saved).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(50))
  expect(h.saved).toHaveBeenCalledTimes(1)
  expect(measureDockLayout(readDockLayout(), visible).panels.projects!.width).toBeCloseTo(0.29)
  h.begin()
  h.pointer('pointermove', 2000)
  h.frame()
  act(() => vi.advanceTimersByTime(250))
  const clamped = h.result.current.layout
  expect(measureDockLayout(clamped, visible).panels.projects!.width).toBeCloseTo(0.88)
  h.pointer('pointermove', 3000)
  h.frame()
  expect(h.result.current.layout).toBe(clamped)
  h.pointer('pointercancel', 0)
  act(() => vi.advanceTimersByTime(250))
  expect(h.saved).toHaveBeenCalledTimes(2)
})

it.each(['pagehide', 'unmount'] as const)('flushes captured user coordinates on %s before the queued frame renders', (exit) => {
  const h = resizeFixture()
  const initial = h.result.current.layout
  h.begin()
  h.pointer('pointermove', 400)
  expect(h.result.current.layout).toBe(initial)
  if (exit === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
  h.unmount()
  expect(readDockLayout()).toEqual(resizeDockSplit(initial, '', 0.4))
  expect(h.saved).toHaveBeenCalledTimes(1)
  expect(h.frames.size).toBe(0)
  act(() => vi.advanceTimersByTime(0))
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves a failed initial read through pagehide and unmount until an explicit reset', () => {
  localStorage.setItem(DOCK_STORAGE_KEY, '{broken')
  const h = resizeFixture()
  act(() => window.dispatchEvent(new Event('pagehide')))
  h.unmount()
  expect(h.saved).not.toHaveBeenCalled()
  expect(localStorage.getItem(DOCK_STORAGE_KEY)).toBe('{broken')
  const reopened = renderHook(() => useDockLayout(visible))
  act(() => reopened.result.current.reset())
  reopened.unmount()
  expect(h.saved).toHaveBeenCalledTimes(1)
  expect(readDockLayout()).toEqual(defaultDockLayout())
})

it('preserves stored layout when the initial storage read throws', () => {
  const stored = JSON.stringify(resizeDockSplit(defaultDockLayout(), '', 0.4))
  localStorage.setItem(DOCK_STORAGE_KEY, stored)
  vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => { throw new Error('storage unavailable') })
  const h = resizeFixture()
  expect(h.result.current.layout).toEqual(defaultDockLayout())
  act(() => window.dispatchEvent(new Event('pagehide')))
  h.unmount()
  expect(h.saved).not.toHaveBeenCalled()
  expect(localStorage.getItem(DOCK_STORAGE_KEY)).toBe(stored)
})

it('moves six panels through the custom menu without remounting content, and persists layout', () => {
  const mounted = vi.fn()
  function Content() { useEffect(() => { mounted() }, []); return <input aria-label="draft" defaultValue="retained draft" /> }
  function Workspace() {
    const dock = useDockLayout(allVisible)
    return <div ref={dock.rootRef}>
      {DOCK_PANELS.map((panel) => <div key={panel} {...dock.panelProps(panel)}>
        <DockHeader panel={panel} targets={[...DOCK_PANELS]} onMove={(target, edge) => dock.movePanel(panel, target, edge)} dragProps={dock.dragProps(panel)} />
        {panel === 'chat' && <Content />}
        {panel === 'terminal' && <div data-testid="terminal-content">shell</div>}
        {panel === 'gitCommitTree' && <div data-testid="commit-tree-content">commits</div>}
      </div>)}
      {dock.dividers.map((divider) => <div key={divider.path} role="separator" {...dock.dividerProps(divider)} />)}
    </div>
  }
  const { container, unmount } = render(<Workspace />)
  const terminal = screen.getByTestId('terminal-content')
  const commitTree = screen.getByTestId('commit-tree-content')
  const nodes = DOCK_PANELS.map((panel) => container.querySelector(`[data-dock-panel="${panel}"]`))
  expect(nodes).toHaveLength(6)
  expect(nodes.every((node) => node?.parentElement === nodes[0]!.parentElement)).toBe(true)
  expect(container.querySelector('select')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '终端布局' }))
  expect(screen.getByRole('dialog', { name: '终端布局选项' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '放到审查右侧' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('terminal-content')).toBe(terminal)
  fireEvent.click(screen.getByRole('button', { name: '提交图布局' }))
  fireEvent.click(screen.getByRole('button', { name: '放到浏览器下方' }))
  expect(screen.getByTestId('commit-tree-content')).toBe(commitTree)
  DOCK_PANELS.forEach((panel, index) => expect(container.querySelector(`[data-dock-panel="${panel}"]`)).toBe(nodes[index]))
  expect(mounted).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('draft')).toHaveValue('retained draft')
  const projectBefore = container.querySelector('[data-dock-panel="projects"]')!.getAttribute('style')
  fireEvent.keyDown(screen.getAllByRole('separator')[0], { key: 'ArrowRight' })
  expect(container.querySelector('[data-dock-panel="projects"]')!.getAttribute('style')).not.toBe(projectBefore)
  expect(mounted).toHaveBeenCalledTimes(1)
  const expected = container.querySelector('[data-dock-panel="terminal"]')!.getAttribute('style')
  const expectedTree = container.querySelector('[data-dock-panel="gitCommitTree"]')!.getAttribute('style')
  fireEvent.click(screen.getByRole('button', { name: '会话布局' }))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '会话布局' })).toHaveFocus()
  unmount()
  const reopened = render(<Workspace />)
  expect(reopened.container.querySelector('[data-dock-panel="terminal"]')!.getAttribute('style')).toBe(expected)
  expect(reopened.container.querySelector('[data-dock-panel="gitCommitTree"]')!.getAttribute('style')).toBe(expectedTree)
})
