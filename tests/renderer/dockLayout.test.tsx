// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useEffect } from 'react'
import type { DragEvent } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DOCK_PANELS, DOCK_EDGES, DOCK_STORAGE_KEY, defaultDockLayout, dockEdgeAt, measureDockLayout, moveDockPanel, normalizeDockLayout, readDockLayout, resizeDockSplit } from '../../src/renderer/src/utils/dockLayout'
import { useDockLayout } from '../../src/renderer/src/hooks/useDockLayout'
import { DockHeader } from '../../src/renderer/src/features/chrome/DockHeader'
import type { DockNode, DockPanel } from '../../src/renderer/src/utils/dockLayout'

const visible = { projects: true, chat: true, review: true, terminal: true }
const leaves = (node: DockNode): DockPanel[] => node.type === 'panel' ? [node.panel] : [...leaves(node.first), ...leaves(node.second)]
beforeEach(() => localStorage.clear())
afterEach(cleanup)

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
    const rects = Object.values(measureDockLayout(layout, visible).panels)
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
  const solo = measureDockLayout(layout, { projects: false, chat: true, review: false, terminal: false })
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

it('moves through the custom menu without remounting drafts or terminal content, and persists layout', () => {
  const mounted = vi.fn()
  function Content() { useEffect(() => { mounted() }, []); return <input aria-label="draft" defaultValue="retained draft" /> }
  function Workspace() {
    const dock = useDockLayout(visible)
    return <div ref={dock.rootRef}>
      {DOCK_PANELS.map((panel) => <div key={panel} {...dock.panelProps(panel)}>
        <DockHeader panel={panel} targets={[...DOCK_PANELS]} onMove={(target, edge) => dock.movePanel(panel, target, edge)} dragProps={dock.dragProps(panel)} />
        {panel === 'chat' && <Content />}
        {panel === 'terminal' && <div data-testid="terminal-content">shell</div>}
      </div>)}
      {dock.dividers.map((divider) => <div key={divider.path} role="separator" {...dock.dividerProps(divider)} />)}
    </div>
  }
  const { container, unmount } = render(<Workspace />)
  const terminal = screen.getByTestId('terminal-content')
  const chat = container.querySelector('[data-dock-panel="chat"]')
  expect(container.querySelector('select')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '终端布局' }))
  expect(screen.getByRole('dialog', { name: '终端布局选项' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '放到审查右侧' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('terminal-content')).toBe(terminal)
  expect(container.querySelector('[data-dock-panel="chat"]')).toBe(chat)
  expect(mounted).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('draft')).toHaveValue('retained draft')
  const projectBefore = container.querySelector('[data-dock-panel="projects"]')!.getAttribute('style')
  fireEvent.keyDown(screen.getAllByRole('separator')[0], { key: 'ArrowRight' })
  expect(container.querySelector('[data-dock-panel="projects"]')!.getAttribute('style')).not.toBe(projectBefore)
  expect(mounted).toHaveBeenCalledTimes(1)
  const expected = container.querySelector('[data-dock-panel="terminal"]')!.getAttribute('style')
  fireEvent.click(screen.getByRole('button', { name: '会话布局' }))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '会话布局' })).toHaveFocus()
  unmount()
  const reopened = render(<Workspace />)
  expect(reopened.container.querySelector('[data-dock-panel="terminal"]')!.getAttribute('style')).toBe(expected)
})
