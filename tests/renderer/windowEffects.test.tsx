// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
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

it('shows Linux restart requirements without claiming desktop blur or enabling renderer alpha early', async () => {
  const set = vi.fn().mockResolvedValue({ ...initial, enabled: true, restartRequired: true, revision: 1,
    message: '设置已保存，重启 Pion 后启用 Linux 合成器透明。' })
  window.pion = { getWindowEffects: vi.fn().mockResolvedValue(initial), onWindowEffects: () => vi.fn(), setWindowEffects: set } as unknown as PionApi
  render(<WindowEffectsSettings />)
  await act(async () => undefined)
  fireEvent.click(screen.getByRole('switch', { name: '原生半透明' }))
  await act(async () => undefined)
  expect(set).toHaveBeenCalledWith(true)
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByText('重启后生效')).toBeInTheDocument()
  expect(screen.getByText(/Wayland\/GNOME 不保证桌面模糊/)).toBeInTheDocument()
  expect(document.documentElement.dataset.nativeSurface).not.toBe('true')
})
