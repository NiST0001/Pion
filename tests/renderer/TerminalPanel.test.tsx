// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import type { ITerminalOptions } from '@xterm/xterm'
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalPanel } from '../../src/renderer/src/features/terminal/TerminalPanel'

// No real xterm renderer or PTY is started.
const mock = vi.hoisted(() => ({
  construct: vi.fn(), dispose: vi.fn(), inputDispose: vi.fn(), unsubscribe: vi.fn(),
  instances: [] as { options: ITerminalOptions }[]
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: ITerminalOptions
    cols = 80
    rows = 24
    constructor(options: ITerminalOptions) {
      mock.construct(options)
      this.options = { ...options }
      mock.instances.push(this)
    }
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    attachCustomKeyEventHandler() {}
    onData() { return { dispose: mock.inputDispose } }
    dispose() { mock.dispose() }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  mock.instances.length = 0
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-native-surface')
})

it('keeps xterm transparent over the shared surface without reopening PTY on theme, surface or visibility changes', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const openTerminal = vi.fn(async () => ({
    id: 'pty-1', cwd: '/project', shell: '/bin/sh', output: '', sequence: 0
  }))
  const closeTerminal = vi.fn()
  vi.stubGlobal('pion', {
    openTerminal, closeTerminal,
    onTerminalData: vi.fn(() => mock.unsubscribe)
  })
  document.documentElement.style.setProperty('--fg', '#eeeeee')
  const view = render(<TerminalPanel cwd="/project" visible />)
  await act(async () => {})
  const terminal = mock.instances[0]
  expect(mock.construct).toHaveBeenCalledWith(expect.objectContaining({
    allowTransparency: true, theme: { background: '#00000000' }
  }))
  expect(terminal.options.theme).toMatchObject({ background: '#00000000', foreground: '#eeeeee' })

  await act(async () => {
    document.documentElement.dataset.theme = 'light'
    document.documentElement.dataset.nativeSurface = 'true'
    document.documentElement.style.setProperty('--fg', '#111111')
  })
  expect(terminal.options.theme).toMatchObject({ background: '#00000000', foreground: '#111111' })
  view.rerender(<TerminalPanel cwd="/project" visible={false} />)
  await act(async () => { document.documentElement.dataset.nativeSurface = 'false' })
  view.rerender(<TerminalPanel cwd="/project" visible />)
  expect(terminal.options.theme?.background).toBe('#00000000')
  expect(mock.construct).toHaveBeenCalledTimes(1)
  expect(openTerminal).toHaveBeenCalledExactlyOnceWith('/project', 80, 24)
  expect(mock.dispose).not.toHaveBeenCalled()
  expect(closeTerminal).not.toHaveBeenCalled()
  view.unmount()
  expect(mock.dispose).toHaveBeenCalledTimes(1)
  expect(closeTerminal).not.toHaveBeenCalled()
})
