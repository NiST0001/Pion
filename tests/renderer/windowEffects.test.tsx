// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWindowEffects } from '../../src/renderer/src/hooks/useWindowEffects'
import { WindowEffectsSettings } from '../../src/renderer/src/features/settings/WindowEffectsSettings'
import type { PionApi } from '../../src/shared/types'
import type { WindowEffectsState } from '../../src/shared/window-effects'

afterEach(() => {
  cleanup()
  delete (window as unknown as { pion?: unknown }).pion
  delete document.documentElement.dataset.nativeSurface
  delete document.documentElement.dataset.nativeSurfaceBackend
})
// Source contracts only: jsdom cannot validate GPU backdrop rendering.
it('gives secondary surfaces local frosting with an accessibility fallback', () => {
  const css = readFileSync('src/renderer/src/styles/window-effects.css', 'utf8')
  const [normal, fallback] = css.split('@media (prefers-reduced-transparency')
  const localPlate = normal.slice(normal.indexOf('/* Filter a separate backplate'))
  for (const name of ['run-metrics-strip', 'run-metrics-detail', 'composer-row', 'task-panel-card', 'modal']) {
    expect(localPlate).toContain(`.${name}`)
    expect(fallback).toContain(`.${name}`)
  }
  expect(localPlate).toContain("backdrop-filter: url('#pion-panel-frost')")
  expect(fallback).toContain('content: none')
  expect(css).not.toContain('filter: blur(12px)')
  expect(css).not.toContain(':has(.modal-backdrop')
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  expect(app).toContain('id="pion-panel-frost"')
  expect(app).toContain('<feFuncA type="linear" slope="0" intercept="1" />')
})

it('does not retain opacity animation backdrop roots around frosted surfaces', () => {
  const css = readFileSync('src/renderer/src/styles/window-effects.css', 'utf8')
  for (const name of ['enter', 'menu-up', 'menu-down', 'scrim']) {
    const keyframes = css.match(new RegExp(`@keyframes pion-frost-${name} \\{[^\\n]+`))?.[0]
    expect(keyframes).toBeDefined()
    expect(keyframes).not.toContain('opacity:')
  }
  expect(css).toContain('animation-fill-mode: backwards')
  expect(css).not.toContain('animation-fill-mode: both')
  expect(css).toContain('.confirm-dialog-backdrop, .tool-permission-backdrop, .extension-ui-backdrop.is-global)')
})

it('anchors scrollable leaf frosting to the border box rather than scrolling pseudo content', () => {
  const css = readFileSync('src/renderer/src/styles/window-effects.css', 'utf8')
  const leafRules = css.slice(css.indexOf('/* Scrollable leaf popovers'), css.indexOf('/* No in-window content'))
  for (const name of ['picker-menu', 'reference-menu', 'slash-command-menu', 'run-metrics-detail', 'history-navigator-preview']) {
    expect(leafRules).toContain(`.${name}`)
  }
  expect(leafRules).toContain("backdrop-filter: url('#pion-panel-frost')")
  expect(leafRules).toContain('content: none')
  const fallback = css.split('@media (prefers-reduced-transparency')[1]
  expect(fallback).toContain('backdrop-filter: none')
})

it('keeps a continuous conversation base and frosts the floating input and summary', () => {
  const css = readFileSync('src/renderer/src/styles/window-effects.css', 'utf8')
  expect(css).not.toContain('.dock-workspace > .main { background: transparent; }')
  expect(css).not.toContain('.main .chat-stage {')
  expect(css).not.toContain(":is(.composer-row, .run-metrics-strip)::before {\n  backdrop-filter: none;")
  const layout = readFileSync('src/renderer/src/styles/history-navigator.css', 'utf8')
  expect(layout).toContain('grid-area: 1 / 1')
  expect(layout).toContain('padding-top: calc(var(--conversation-top-clearance, 0px)')
  expect(layout).toContain('padding-bottom: calc(var(--conversation-bottom-clearance, 0px)')
})

it('positions permission requests above the measured composer without reserving message space', () => {
  // Source contract: actual geometry requires Electron, not jsdom.
  const css = readFileSync('src/renderer/src/styles/permissions.css', 'utf8')
  const backdrop = css.match(/\.tool-permission-backdrop\s*\{([^}]*)\}/)?.[1] ?? ''
  expect(backdrop).toContain('position: absolute')
  expect(backdrop).toContain('bottom: var(--conversation-bottom-clearance, 0px)')
  expect(backdrop).toContain('align-items: flex-end')
  const overlays = readFileSync('src/renderer/src/hooks/useConversationOverlays.ts', 'utf8')
  expect(overlays).toContain("shell.querySelector<HTMLElement>('.composer-dock')")
  expect(overlays).toContain("shell.style.setProperty('--conversation-bottom-clearance'")
  expect(overlays).toContain('observer.observe(composer)')
})

const initial: WindowEffectsState = { enabled: false, active: false, available: true, restartRequired: false,
  backend: 'linux-alpha', blur: 'none', message: 'opaque', revision: 0 }

it('does not let a delayed snapshot disable a newer native effect', async () => {
  let deliver!: (state: WindowEffectsState) => void
  let resolve!: (state: WindowEffectsState) => void
  const pending = new Promise<WindowEffectsState>((done) => { resolve = done })
  window.pion = { getWindowEffects: () => pending,
    onWindowEffects: (callback: typeof deliver) => { deliver = callback; return vi.fn() }
  } as unknown as PionApi
  const { result } = renderHook(() => useWindowEffects(true))
  act(() => deliver({ ...initial, enabled: true, active: true, revision: 2 }))
  await act(async () => { resolve(initial); await pending })
  expect(result.current.state?.revision).toBe(2)
  expect(document.documentElement.dataset.nativeSurface).toBe('true')
  act(() => deliver({ ...initial, revision: 3 }))
  expect(document.documentElement.dataset.nativeSurface).toBe('false')
})

it.each([
  { state: { ...initial, enabled: true, active: true, backend: 'windows-dwm' as const, blur: 'native' as const }, notice: '' },
  { state: { ...initial, enabled: true, active: true }, notice: '当前系统仅支持透明效果。' },
  { state: { ...initial, available: false }, notice: '当前系统不支持此效果。' },
  { state: { ...initial, enabled: true }, notice: '当前效果未生效。' }
])('shows only essential glass-effect status: $notice', async ({ state, notice }) => {
  window.pion = { getWindowEffects: vi.fn().mockResolvedValue({ ...state, message: '技术说明：合成器 Acrylic Wayland' }),
    onWindowEffects: () => vi.fn() } as unknown as PionApi
  render(<WindowEffectsSettings />)
  await act(async () => undefined)
  expect(screen.getByRole('switch', { name: '毛玻璃' })).toHaveAttribute('aria-checked', String(state.enabled))
  expect(screen.queryByText(/合成器|Acrylic|Wayland|原生半透明/)).not.toBeInTheDocument()
  if (notice) expect(screen.getByRole('status')).toHaveTextContent(notice)
  else expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('shows Linux restart requirements without claiming desktop blur or enabling renderer alpha early', async () => {
  const set = vi.fn().mockResolvedValue({ ...initial, enabled: true, restartRequired: true, revision: 1,
    message: '设置已保存，重启 Pion 后启用 Linux 合成器透明。' })
  window.pion = { getWindowEffects: vi.fn().mockResolvedValue(initial), onWindowEffects: () => vi.fn(), setWindowEffects: set } as unknown as PionApi
  render(<WindowEffectsSettings />)
  await act(async () => undefined)
  fireEvent.click(screen.getByRole('switch', { name: '毛玻璃' }))
  await act(async () => undefined)
  expect(set).toHaveBeenCalledWith(true)
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByRole('status')).toHaveTextContent('重启 Pion 后生效。')
  expect(screen.queryByText(/合成器|Wayland|原生半透明/)).not.toBeInTheDocument()
  expect(document.documentElement.dataset.nativeSurface).not.toBe('true')
})
