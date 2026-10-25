// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { StrictMode } from 'react'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDockLayout } from '../../src/renderer/src/hooks/useDockLayout'
import { usePanelLayout } from '../../src/renderer/src/hooks/usePanelLayout'
import { DOCK_PANELS, DOCK_STORAGE_KEY, DOCK_VISIBILITY_STORAGE_KEY, defaultDockLayout, defaultDockVisibility,
  measureDockLayout, readDockLayout, readDockVisibility } from '../../src/renderer/src/utils/dockLayout'

function useWorkbenchLayout() {
  const panels = usePanelLayout(false)
  const visible = { projects: panels.sidebarOpen, chat: true, review: panels.reviewOpen,
    terminal: panels.terminalOpen, browser: panels.browserOpen, gitCommitTree: panels.gitCommitTreeOpen }
  return { panels, visible, dock: useDockLayout(visible) }
}

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('restores moved panels, resized splits and every panel visibility after remount', () => {
  const first = renderHook(useWorkbenchLayout)
  const setters = [first.result.current.panels.setSidebarOpen, first.result.current.panels.setReviewOpen,
    first.result.current.panels.setTerminalOpen, first.result.current.panels.setBrowserOpen,
    first.result.current.panels.setGitCommitTreeOpen]
  act(() => {
    for (const set of setters) set((open) => !open)
    first.result.current.dock.movePanel('terminal', 'chat', 'top')
  })
  const beforeResize = first.result.current.dock.layout
  const divider = first.result.current.dock.dividers[0]
  act(() => first.result.current.dock.dividerProps(divider).onKeyDown({
    key: divider.axis === 'x' ? 'ArrowRight' : 'ArrowDown', preventDefault: vi.fn()
  } as never))
  const saved = first.result.current.dock.layout
  expect(saved).not.toEqual(beforeResize)
  expect(saved).not.toEqual(defaultDockLayout())
  expect(first.result.current.visible).toEqual({ projects: false, chat: true, review: false,
    terminal: true, browser: true, gitCommitTree: true })
  expect(first.result.current.panels.setTerminalOpen).toBe(setters[2])
  first.unmount()
  const restored = renderHook(useWorkbenchLayout)
  expect(restored.result.current.dock.layout).toEqual(saved)
  expect(restored.result.current.visible).toEqual(readDockVisibility())
  expect(restored.result.current.visible).toEqual({ projects: false, chat: true, review: false,
    terminal: true, browser: true, gitCommitTree: true })
})

it('only accepts boolean panel flags and never disables chat', () => {
  localStorage.setItem(DOCK_VISIBILITY_STORAGE_KEY, JSON.stringify({ projects: false, chat: false,
    review: 'false', terminal: true, browser: 1, gitCommitTree: true, unknown: true }))
  expect(readDockVisibility()).toEqual({ projects: false, chat: true, review: true,
    terminal: true, browser: false, gitCommitTree: true })
  const write = vi.spyOn(Storage.prototype, 'setItem')
  const hook = renderHook(useWorkbenchLayout)
  expect(hook.result.current.visible.chat).toBe(true)
  expect(write).not.toHaveBeenCalled()
})

it.each([
  ['pion:dock-layout-v1', JSON.stringify({ version: 1,
    slots: { projects: 'right', chat: 'center', review: 'left', terminal: 'bottom' }, left: 280 })],
  [DOCK_STORAGE_KEY, JSON.stringify({ version: 2, root: { type: 'split', axis: 'x', ratio: 0.31,
    first: { type: 'panel', panel: 'projects' }, second: { type: 'split', axis: 'x', ratio: 0.72,
      first: { type: 'panel', panel: 'chat' }, second: { type: 'split', axis: 'y', ratio: 0.41,
        first: { type: 'panel', panel: 'review' }, second: { type: 'panel', panel: 'terminal' } } } } })]
])('reads %s without rewriting the old cache or persisting migration until a change', (key, raw) => {
  localStorage.setItem(key, raw)
  const migrated = readDockLayout()
  const write = vi.spyOn(Storage.prototype, 'setItem')
  const hook = renderHook(useWorkbenchLayout)
  expect(hook.result.current.dock.layout).toEqual(migrated)
  expect(localStorage.getItem(key)).toBe(raw)
  expect(write).not.toHaveBeenCalled()
  act(() => hook.result.current.panels.setTerminalOpen(true))
  expect(localStorage.getItem(key)).toBe(raw)
  expect(write).not.toHaveBeenCalledWith(DOCK_STORAGE_KEY, expect.anything())
})

it.each([null, '{broken', '[]', 'false'])('does not overwrite missing or damaged caches on initial mount: %s', (raw) => {
  if (raw !== null) {
    localStorage.setItem(DOCK_STORAGE_KEY, raw)
    localStorage.setItem(DOCK_VISIBILITY_STORAGE_KEY, raw)
  }
  const write = vi.spyOn(Storage.prototype, 'setItem')
  const hook = renderHook(useWorkbenchLayout, { wrapper: StrictMode })
  expect(hook.result.current.dock.layout).toEqual(defaultDockLayout())
  expect(hook.result.current.visible).toEqual(defaultDockVisibility())
  expect(write).not.toHaveBeenCalled()
  expect(localStorage.getItem(DOCK_STORAGE_KEY)).toBe(raw)
  expect(localStorage.getItem(DOCK_VISIBILITY_STORAGE_KEY)).toBe(raw)
})

it('does not write fallback defaults when storage cannot be read', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable') })
  const write = vi.spyOn(Storage.prototype, 'setItem')
  const hook = renderHook(useWorkbenchLayout)
  expect(hook.result.current.visible).toEqual(defaultDockVisibility())
  expect(hook.result.current.dock.layout).toEqual(defaultDockLayout())
  expect(write).not.toHaveBeenCalled()
})

it('persists explicit visibility reset even when fallback defaults are already displayed', () => {
  localStorage.setItem(DOCK_VISIBILITY_STORAGE_KEY, '{broken')
  const hook = renderHook(useWorkbenchLayout)
  act(() => hook.result.current.panels.resetPanelVisibility())
  expect(JSON.parse(localStorage.getItem(DOCK_VISIBILITY_STORAGE_KEY)!)).toEqual(defaultDockVisibility())
  act(() => {
    hook.result.current.panels.setSidebarOpen(false)
    hook.result.current.panels.setTerminalOpen(true)
    hook.result.current.dock.movePanel('review', 'chat', 'bottom')
  })
  act(() => {
    hook.result.current.panels.resetPanelVisibility()
    hook.result.current.dock.reset()
  })
  hook.unmount()
  const restored = renderHook(useWorkbenchLayout)
  expect(restored.result.current.visible).toEqual(defaultDockVisibility())
  expect(restored.result.current.dock.layout).toEqual(defaultDockLayout())
})

it('wires restored panels into initial lazy hosts and binds a restored terminal only once a cwd is available', () => {
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  expect(app).toContain('useState(browserOpen)')
  expect(app).toContain('useState(gitCommitTreeOpen)')
  expect(app).toContain('if (terminalOpen && !terminalCwd && resourceCwd) setTerminalCwd(resourceCwd)')
  expect(app).toContain('dock.reset(); resetPanelVisibility()')
  expect(app).not.toMatch(/\[(?:terminalOpen|browserOpen|gitCommitTreeOpen),[^\]]+\]\s*=\s*useState\(false\)/)
})

it('keeps fixed panel DOM identities when hiding, moving and resetting the layout', () => {
  let current!: ReturnType<typeof useWorkbenchLayout>
  function Harness() {
    current = useWorkbenchLayout()
    return <div>{DOCK_PANELS.map((panel) => <div key={panel} data-testid={panel} {...current.dock.panelProps(panel)} />)}</div>
  }
  render(<Harness />)
  const nodes = DOCK_PANELS.map((panel) => screen.getByTestId(panel))
  act(() => {
    current.panels.setTerminalOpen(true)
    current.panels.setBrowserOpen(true)
    current.panels.setGitCommitTreeOpen(true)
    current.dock.movePanel('chat', 'review', 'bottom')
  })
  const saved = current.dock.layout
  act(() => current.panels.setBrowserOpen(false))
  expect(current.dock.layout).toBe(saved)
  expect(measureDockLayout(saved, current.visible).panels.browser).toBeUndefined()
  act(() => { current.panels.resetPanelVisibility(); current.dock.reset() })
  DOCK_PANELS.forEach((panel, index) => expect(screen.getByTestId(panel)).toBe(nodes[index]))
})
