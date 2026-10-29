// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ComputerUseSettings } from '../../src/renderer/src/features/computer-use/ComputerUseSettings'
import { SecurityPage } from '../../src/renderer/src/features/settings/SecurityPage'
import { createDisabledComputerUseStatus } from '../../src/shared/computer-use'
import type { ComputerUseStatus } from '../../src/shared/computer-use'
import type { PionApi } from '../../src/shared/pion-api'
const descriptor = Object.getOwnPropertyDescriptor(window, 'pion')
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
afterEach(() => {
  cleanup(); vi.restoreAllMocks()
  if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
  else delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
  if (descriptor) Object.defineProperty(window, 'pion', descriptor); else delete (window as unknown as { pion?: unknown }).pion })
function mock() {
  const consent = { capture: true, upload: false, control: false, retention: 'sdk-session' as const }
  const state = { ...createDisabledComputerUseStatus(), state: 'ready' as const, coordination: 'held' as const, revision: 2, scopeRevision: 1, consent,
    capability: { platform: 'linux-wayland', method: 'portal-screencast', capture: true, control: false, unsupportedReason: 'control-unavailable', scope: 'window' } }
  const api = { getState: vi.fn().mockResolvedValue(createDisabledComputerUseStatus()), onState: vi.fn((_listener: (state: ComputerUseStatus) => void) => vi.fn()), start: vi.fn().mockResolvedValue(state), capture: vi.fn().mockResolvedValue({ state: { ...state, revision: 3 }, previewUnavailable: 'thumbnail-not-supported' }), stop: vi.fn().mockResolvedValue({ ...state, state: 'stopped', coordination: 'released', scopeRevision: 2, revision: 4 }) }
  window.pion = { computerUse: api } as unknown as PionApi
  return api
}
const flush = async () => { await act(async () => { await Promise.resolve() }) }
it('security entry has no new IPC until an explicit click, and closing passive reads never stops', async () => {
  const api = mock()
  render(<SecurityPage projectTrust={null} projectTrustBusy={false} projectTrustError="" onProjectTrustChange={vi.fn()} toolPermissionPolicy={null} toolPermissionBusy={false} toolPermissionError="" onToolPermissionChange={vi.fn()} onToolPermissionReset={vi.fn()} />)
  expect(api.getState).not.toHaveBeenCalled(); expect(api.onState).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '桌面观察（实验）' })); await flush()
  expect(api.getState).toHaveBeenCalledTimes(1); expect(api.start).not.toHaveBeenCalled(); expect(api.capture).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '关闭窗口观察面板' }))
  expect(api.stop).not.toHaveBeenCalled()
})
it('only the consent button starts; capture remains manual and local', async () => {
  const api = mock(); render(<ComputerUseSettings />)
  fireEvent.click(screen.getByRole('button', { name: '桌面观察（实验）' })); await flush()
  expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: /我同意本次通过系统 Portal/ }))
  expect(api.start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '开始本次窗口观察' })); await flush()
  expect(api.start).toHaveBeenCalledWith({ capture: true, upload: false, control: false, retention: 'sdk-session' })
  expect(api.capture).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '获取本地静态截图' })); await flush()
  expect(api.capture).toHaveBeenCalledWith({ scopeRevision: 1 })
  expect(screen.getByText('当前系统无法生成本地缩略图。')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '关闭窗口观察面板' })); await flush()
  expect(api.stop).toHaveBeenCalledTimes(1)
})
it('inactive settings stop only owned observation and reopening does not replay actions', async () => {
  const api = mock(); const view = render(<ComputerUseSettings active />)
  fireEvent.click(screen.getByRole('button', { name: '桌面观察（实验）' })); await flush()
  fireEvent.click(screen.getByRole('checkbox', { name: /我同意本次通过系统 Portal/ }))
  fireEvent.click(screen.getByRole('button', { name: '开始本次窗口观察' })); await flush()
  view.rerender(<ComputerUseSettings active={false} />); expect(api.stop).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  view.rerender(<ComputerUseSettings active />); await flush()
  expect(api.getState).toHaveBeenCalledTimes(1); expect(api.start).toHaveBeenCalledTimes(1); expect(api.capture).not.toHaveBeenCalled()
})

function selectMode(value: 'window' | 'display') {
  fireEvent.click(screen.getByRole('combobox', { name: '本次观察模式' }))
  fireEvent.click(screen.getByRole('option', { name: value === 'display' ? '屏幕控制准备（独立授权）' : '窗口观察（默认）' }))
}
it('keeps screen consent local, starts exact display scope, and clears permission on mode switch and settings navigation', async () => {
  const api = mock()
  api.getState.mockResolvedValue({ ...createDisabledComputerUseStatus(), inputDevelopmentEnabled: true })
  const displayConsent = { capture: true, upload: false, control: true, retention: 'sdk-session' as const, captureScope: 'display' as const }
  const displayState: ComputerUseStatus = { ...createDisabledComputerUseStatus(), inputDevelopmentEnabled: true, state: 'ready', coordination: 'held', revision: 2, scopeRevision: 1,
    consent: displayConsent, capability: { platform: 'linux-wayland', method: 'portal-screencast+wayland-virtual-input', capture: true, control: true, scope: 'display' } }
  api.start.mockResolvedValue(displayState as Awaited<ReturnType<typeof api.start>>)
  let resolveStop!: (state: ComputerUseStatus) => void
  api.stop.mockReturnValue(new Promise(resolve => { resolveStop = resolve }))
  const view = render(<ComputerUseSettings active />)
  fireEvent.click(screen.getByRole('button', { name: '桌面观察（实验）' })); await flush()
  selectMode('display')
  expect(api.stop).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled()
  for (const check of screen.getAllByRole('checkbox')) expect(check).not.toBeChecked()
  fireEvent.click(screen.getByRole('checkbox', { name: /我同意本次通过系统 Portal/ }))
  expect(screen.getByRole('button', { name: '开始本次屏幕控制准备' })).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: /全局键鼠/ }))
  fireEvent.click(screen.getByRole('button', { name: '开始本次屏幕控制准备' })); await flush()
  expect(api.start).toHaveBeenCalledExactlyOnceWith(displayConsent)
  expect(api.capture).not.toHaveBeenCalled()
  selectMode('window')
  expect(api.stop).toHaveBeenCalledTimes(1)
  selectMode('display')
  expect(api.stop).toHaveBeenCalledTimes(1)
  for (const check of screen.getAllByRole('checkbox')) expect(check).not.toBeChecked()
  expect(screen.getByRole('button', { name: '开始本次屏幕控制准备' })).toBeDisabled()
  view.rerender(<ComputerUseSettings active={false} />)
  view.rerender(<ComputerUseSettings active />); await flush()
  fireEvent.click(screen.getByRole('button', { name: '桌面观察（实验）' })); await flush()
  expect(api.stop).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('combobox', { name: '本次观察模式' })).toHaveTextContent('窗口观察（默认）')
  expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
  await act(async () => resolveStop({ ...createDisabledComputerUseStatus(), inputDevelopmentEnabled: true, state: 'stopped', coordination: 'released', scopeRevision: 2, revision: 4 }))
  expect(api.start).toHaveBeenCalledTimes(1)
})

function scrollGeometry(page: HTMLElement, consentTop = 900, initialScrollTop = 0) {
  const rect = (top: number, height: number): DOMRect => ({ top, bottom: top + height, height,
    left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) })
  const original = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === page) return rect(100, 400)
    if (this.matches('.computer-use-consent')) return rect(consentTop, 220)
    return original.call(this)
  })
  let scrollTop = initialScrollTop
  const setScrollTop = vi.fn((value: number) => { scrollTop = value })
  Object.defineProperties(page, {
    clientTop: { configurable: true, value: 0 },
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 2000 },
    scrollTop: { configurable: true, get: () => scrollTop, set: setScrollTop }
  })
  const scrollIntoView = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  const focus = vi.spyOn(HTMLElement.prototype, 'focus')
  return { setScrollTop, scrollIntoView, focus }
}

it('explicit open centers consent once in the nearest settings page without changing other scroll or permission', async () => {
  const api = mock()
  let resolveState!: (state: ComputerUseStatus) => void
  api.getState.mockReturnValueOnce(new Promise<ComputerUseStatus>(resolve => { resolveState = resolve }))
  const content = (active: boolean) => <div data-testid="root"><div data-testid="chat" />
    <div className="settings-content"><div className="settings-page" data-testid="outer-page">
      <div className="settings-page" data-testid="page"><ComputerUseSettings active={active} /></div>
    </div></div></div>
  const view = render(content(true))
  const page = screen.getByTestId('page')
  const geometry = scrollGeometry(page)
  const otherScrollers = [document.documentElement, document.body, screen.getByTestId('root'),
    screen.getByTestId('chat'), screen.getByTestId('outer-page'), view.container]
  const positions = otherScrollers.map(element => element.scrollTop)
  const otherScrollWrites = otherScrollers.map(element => vi.spyOn(element, 'scrollTop', 'set'))
  const unchanged = () => {
    expect(geometry.setScrollTop).toHaveBeenCalledTimes(1)
    expect(page.scrollTop).toBe(710)
    expect(otherScrollers.map(element => element.scrollTop)).toEqual(positions)
    for (const setter of otherScrollWrites) expect(setter).not.toHaveBeenCalled()
    expect(geometry.scrollIntoView).not.toHaveBeenCalled()
    expect(geometry.focus).not.toHaveBeenCalled()
    expect(api.start).not.toHaveBeenCalled(); expect(api.capture).not.toHaveBeenCalled()
    expect(api.stop).not.toHaveBeenCalled()
    for (const checkbox of screen.queryAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
  }
  expect(geometry.setScrollTop).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '桌面观察（实验）' }))
  // The reveal is synchronous layout work, not a consequence of getState resolving.
  expect(geometry.setScrollTop).toHaveBeenCalledWith(710); unchanged()
  await act(async () => { resolveState(createDisabledComputerUseStatus()) }); unchanged()
  act(() => { api.onState.mock.calls[0][0]({ ...createDisabledComputerUseStatus(), revision: 1 }) }); unchanged()
  view.rerender(content(true)); unchanged()
  fireEvent.click(screen.getByRole('button', { name: '关闭窗口观察面板' })); await flush(); unchanged()
  view.rerender(content(false)); unchanged()
  view.rerender(content(true)); await flush(); unchanged()
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  // Hiding an open, read-only panel also must not replay the reveal on activation.
  fireEvent.click(screen.getByRole('button', { name: '桌面观察（实验）' })); await flush()
  expect(geometry.setScrollTop).toHaveBeenCalledTimes(2)
  geometry.setScrollTop.mockClear()
  view.rerender(content(false)); view.rerender(content(true)); await flush()
  expect(geometry.setScrollTop).not.toHaveBeenCalled()
  expect(otherScrollers.map(element => element.scrollTop)).toEqual(positions)
  for (const setter of otherScrollWrites) expect(setter).not.toHaveBeenCalled()
  expect(geometry.scrollIntoView).not.toHaveBeenCalled(); expect(geometry.focus).not.toHaveBeenCalled()
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  expect(api.start).not.toHaveBeenCalled(); expect(api.capture).not.toHaveBeenCalled()
  expect(api.stop).not.toHaveBeenCalled()
})

it.each([
  { consentTop: -300, initialScrollTop: 50, expected: 0 },
  { consentTop: 3000, initialScrollTop: 50, expected: 1600 },
  { consentTop: 900, initialScrollTop: 100, expected: 810 },
  { consentTop: 200, initialScrollTop: 50, expected: undefined }
])('consent reveal respects scroll bounds and already-visible content: $consentTop/$initialScrollTop', async ({ consentTop, initialScrollTop, expected }) => {
  const api = mock()
  render(<div className="settings-content"><div className="settings-page" data-testid="page"><ComputerUseSettings /></div></div>)
  const page = screen.getByTestId('page')
  const geometry = scrollGeometry(page, consentTop, initialScrollTop)
  fireEvent.click(screen.getByRole('button', { name: '桌面观察（实验）' })); await flush()
  if (expected === undefined) {
    expect(geometry.setScrollTop).not.toHaveBeenCalled()
    expect(page.scrollTop).toBe(initialScrollTop)
  } else {
    expect(geometry.setScrollTop).toHaveBeenCalledTimes(1)
    expect(geometry.setScrollTop).toHaveBeenCalledWith(expected)
    expect(page.scrollTop).toBe(expected)
  }
  expect(geometry.scrollIntoView).not.toHaveBeenCalled(); expect(geometry.focus).not.toHaveBeenCalled()
  for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
  expect(api.start).not.toHaveBeenCalled(); expect(api.capture).not.toHaveBeenCalled()
})

it.each(['', 'settings-page', 'settings-content'])('does not reveal without the complete settings shell: %s', async className => {
  const api = mock()
  render(<div className={className} data-testid="shell"><ComputerUseSettings /></div>)
  const shell = screen.getByTestId('shell')
  const geometry = scrollGeometry(shell)
  fireEvent.click(screen.getByRole('button', { name: '桌面观察（实验）' })); await flush()
  expect(geometry.setScrollTop).not.toHaveBeenCalled(); expect(shell.scrollTop).toBe(0)
  expect(geometry.scrollIntoView).not.toHaveBeenCalled(); expect(geometry.focus).not.toHaveBeenCalled()
  for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
  expect(api.start).not.toHaveBeenCalled(); expect(api.capture).not.toHaveBeenCalled()
})
