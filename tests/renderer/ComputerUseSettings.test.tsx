// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ComputerUseSettings } from '../../src/renderer/src/features/computer-use/ComputerUseSettings'
import { SecurityPage } from '../../src/renderer/src/features/settings/SecurityPage'
import { createDisabledComputerUseStatus } from '../../src/shared/computer-use'
import type { PionApi } from '../../src/shared/pion-api'
const descriptor = Object.getOwnPropertyDescriptor(window, 'pion')
afterEach(() => { cleanup(); if (descriptor) Object.defineProperty(window, 'pion', descriptor); else delete (window as unknown as { pion?: unknown }).pion })
function mock() {
  const consent = { capture: true, upload: false, control: false, retention: 'sdk-session' as const }
  const state = { ...createDisabledComputerUseStatus(), state: 'observing' as const, revision: 2, scopeRevision: 1, consent,
    capability: { platform: 'linux-wayland', method: 'portal-screencast', capture: true, control: false, unsupportedReason: 'control-unavailable', scope: 'window' } }
  const api = { getState: vi.fn().mockResolvedValue(createDisabledComputerUseStatus()), onState: vi.fn(() => vi.fn()), start: vi.fn().mockResolvedValue(state), capture: vi.fn().mockResolvedValue({ state: { ...state, revision: 3 }, previewUnavailable: 'thumbnail-not-supported' }), stop: vi.fn().mockResolvedValue({ ...state, state: 'stopped', scopeRevision: 2, revision: 4 }) }
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
