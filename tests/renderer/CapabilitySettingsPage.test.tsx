// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CapabilitySettingsPage } from '../../src/renderer/src/features/settings/CapabilitySettingsPage'
import {
  PI_CORE_TOOL_NAMES,
  type CapabilityItem,
  type CapabilitySettingsSnapshot,
  type CapabilitySettingsUpdate
} from '../../src/shared/capability-settings'
import type { PionApi } from '../../src/shared/pion-api'

let originalApi: PropertyDescriptor | undefined
let originalVisibility: PropertyDescriptor | undefined
beforeEach(() => {
  originalApi = Object.getOwnPropertyDescriptor(window, 'pion')
  originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  if (originalApi) Object.defineProperty(window, 'pion', originalApi)
  else delete (window as unknown as { pion?: unknown }).pion
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
  else delete (document as unknown as { visibilityState?: unknown }).visibilityState
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function slot(): MutableRefObject<Promise<void> | null> { return { current: null } }
function snapshot(cwd = '/a', overrides: Partial<CapabilitySettingsSnapshot> = {}): CapabilitySettingsSnapshot {
  const core: CapabilityItem[] = PI_CORE_TOOL_NAMES.map((name) => ({
    id: `tool:${name}`, kind: 'tool', name, label: name, description: 'Pi 编码工具',
    origin: 'pi', enabled: true, available: true
  }))
  return {
    cwd, revision: 4, catalogueRevision: `catalogue:${cwd}`,
    items: [...core,
      { id: 'tool:pion_task', kind: 'tool', name: 'pion_task', label: 'Pion 任务', description: '管理任务', origin: 'pion', enabled: true, available: true },
      { id: 'tool:pion_generate_image', kind: 'tool', name: 'pion_generate_image', label: '图像生成', description: '生成图片', origin: 'pion', enabled: true, available: false, unavailableReason: 'private unavailable diagnostic' },
      { id: 'mcp:server', kind: 'mcp', name: 'server', label: '示例 MCP', description: 'MCP 服务器', origin: 'user', enabled: true, available: true },
      { id: 'skill:example', kind: 'skill', name: 'example', label: '示例 Skill', description: '项目技能', origin: 'project', enabled: true, available: true },
      { id: 'tool:pion_subagents', kind: 'subagent', name: 'pion_subagents', label: '委派子代理', description: '子代理入口', origin: 'pion', enabled: true, available: false },
      { id: 'extension:example', kind: 'extension', name: 'example-extension', label: '示例扩展', description: '扩展入口', origin: 'extension', enabled: true, available: true }
    ],
    notices: [], application: { state: 'applied', requestedRevision: 4, appliedRevision: 4, pendingBackends: 0 },
    ...overrides
  }
}
function api(get: (cwd?: string) => Promise<CapabilitySettingsSnapshot>, update: (request: CapabilitySettingsUpdate) => Promise<CapabilitySettingsSnapshot> = vi.fn()) {
  return { getCapabilitySettings: get, updateCapabilitySettings: update } as unknown as PionApi
}
async function flush(): Promise<void> { await act(async () => { await Promise.resolve() }) }

it('sends each preset as one revision-bound transaction and leaves every switch independently editable', async () => {
  let saved = snapshot()
  const update = vi.fn(async (request: CapabilitySettingsUpdate) => {
    const { change } = request
    saved = { ...saved, revision: saved.revision + 1, items: saved.items.map((item) => {
      if (change.type === 'toggle') return item.id === change.id ? { ...item, enabled: change.enabled } : item
      if (change.preset === 'no-skills') return item.kind === 'skill' ? { ...item, enabled: false } : item
      return { ...item, enabled: change.preset === 'standard' || (item.kind === 'tool' && item.origin === 'pi') }
    }) }
    return saved
  })
  window.pion = api(vi.fn(async () => saved), update)
  const { container } = render(<CapabilitySettingsPage cwd="/a" actionSlot={slot()} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '极简模式' })).toBeEnabled())
  for (const name of ['工具', 'MCP', 'Skill', '子代理', '扩展入口']) expect(screen.getByRole('region', { name })).toBeInTheDocument()
  expect(container.querySelector('select')).toBeNull()
  for (const name of ['极简模式', '标准模式', '无Skill模式']) expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-pressed')

  fireEvent.click(screen.getByRole('button', { name: '极简模式' }))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Pion 任务' })).toHaveAttribute('aria-checked', 'false'))
  expect(update).toHaveBeenCalledExactlyOnceWith({ cwd: '/a', expectedRevision: 4, catalogueRevision: 'catalogue:/a', change: { type: 'preset', preset: 'minimal' } })
  for (const name of PI_CORE_TOOL_NAMES) expect(screen.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'true')
  for (const name of ['示例 MCP', '示例 Skill', '委派子代理', '示例扩展']) expect(screen.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'false')

  fireEvent.click(screen.getByRole('switch', { name: 'Pion 任务' }))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Pion 任务' })).toHaveAttribute('aria-checked', 'true'))
  expect(update).toHaveBeenLastCalledWith({ cwd: '/a', expectedRevision: 5, catalogueRevision: 'catalogue:/a', change: { type: 'toggle', id: 'tool:pion_task', enabled: true } })
  fireEvent.click(screen.getByRole('button', { name: '标准模式' }))
  await waitFor(() => expect(screen.getByRole('switch', { name: '示例 Skill' })).toHaveAttribute('aria-checked', 'true'))
  expect(update).toHaveBeenLastCalledWith({ cwd: '/a', expectedRevision: 6, catalogueRevision: 'catalogue:/a', change: { type: 'preset', preset: 'standard' } })
  expect(screen.getByRole('switch', { name: '图像生成' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '无Skill模式' }))
  await waitFor(() => expect(screen.getByRole('switch', { name: '示例 Skill' })).toHaveAttribute('aria-checked', 'false'))
  expect(update).toHaveBeenLastCalledWith({ cwd: '/a', expectedRevision: 7, catalogueRevision: 'catalogue:/a', change: { type: 'preset', preset: 'no-skills' } })
  expect(update).toHaveBeenCalledTimes(4)
  expect(screen.getByRole('switch', { name: '示例 MCP' })).toHaveAttribute('aria-checked', 'true')
})

it('allows turning off an unavailable capability, deduplicates saves and retains confirmed state after a private error', async () => {
  const pending = deferred<CapabilitySettingsSnapshot>()
  const update = vi.fn(() => pending.promise)
  const actionSlot = slot()
  window.pion = api(vi.fn(async () => snapshot()), update)
  render(<CapabilitySettingsPage cwd="/a" actionSlot={actionSlot} />)
  const toggle = await screen.findByRole('switch', { name: '图像生成' })
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(screen.queryByText('private unavailable diagnostic')).not.toBeInTheDocument()
  fireEvent.click(toggle)
  fireEvent.click(toggle)
  await flush()
  expect(update).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenLastCalledWith({ cwd: '/a', expectedRevision: 4, catalogueRevision: 'catalogue:/a', change: { type: 'toggle', id: 'tool:pion_generate_image', enabled: false } })
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(toggle).toBeDisabled()
  const actual = actionSlot.current
  expect(actual).not.toBeNull()
  await act(async () => { pending.reject(new Error('private token and filesystem diagnostic')); await actual })
  expect(actionSlot.current).toBeNull()
  expect(screen.getByRole('alert')).toHaveTextContent('保存失败')
  expect(document.body).not.toHaveTextContent('private token')
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(toggle).toBeEnabled()
})

it('retains the host mutation slot across unmount, scope and API replacement until the real promise settles', async () => {
  const pending = deferred<CapabilitySettingsSnapshot>()
  const actionSlot = slot()
  const getA = vi.fn(async () => snapshot())
  const updateA = vi.fn(() => pending.promise)
  window.pion = api(getA, updateA)
  const first = render(<CapabilitySettingsPage cwd="/a" actionSlot={actionSlot} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '极简模式' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '极简模式' }))
  await flush()
  const actual = actionSlot.current
  first.unmount()
  vi.useFakeTimers()
  const b = snapshot('/b', { revision: 20, items: [{ ...snapshot().items[0], id: 'tool:b', name: 'b', label: 'B 工具' }] })
  const getB = vi.fn(async () => b)
  const updateB = vi.fn()
  window.pion = api(getB, updateB)
  render(<CapabilitySettingsPage cwd="/b" actionSlot={actionSlot} />)
  await act(async () => { vi.advanceTimersByTime(60_000) })
  expect(actionSlot.current).toBe(actual)
  expect(getB).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '标准模式' }))
  expect(updateB).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(snapshot('/a', { revision: 5 })); await actual })
  expect(actionSlot.current).toBeNull()
  expect(getB).toHaveBeenCalledExactlyOnceWith('/b')
  expect(screen.getByRole('switch', { name: 'B 工具' })).toHaveAttribute('aria-checked', 'true')
  expect(screen.queryByRole('switch', { name: 'read' })).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('holds the real read slot across cwd/scope A-B-A and discards the old response before reading the fresh catalogue', async () => {
  const stale = deferred<CapabilitySettingsSnapshot>()
  const fresh = deferred<CapabilitySettingsSnapshot>()
  const get = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
  window.pion = api(get)
  const actionSlot = slot()
  const first = render(<CapabilitySettingsPage cwd="/a" scope="a1" actionSlot={actionSlot} />)
  await flush()
  first.unmount()
  const { rerender } = render(<CapabilitySettingsPage cwd="/b" scope="b" actionSlot={actionSlot} />)
  rerender(<CapabilitySettingsPage cwd="/a" scope="a2" actionSlot={actionSlot} />)
  await flush()
  expect(get).toHaveBeenCalledTimes(1)
  const old = snapshot('/a', { items: [{ ...snapshot().items[0], label: '旧目录工具' }] })
  await act(async () => stale.resolve(old))
  expect(get).toHaveBeenCalledTimes(2)
  expect(get).toHaveBeenLastCalledWith('/a')
  expect(screen.queryByRole('switch', { name: '旧目录工具' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '标准模式' })).toBeDisabled()
  await act(async () => fresh.resolve(snapshot('/a', { revision: 9 })))
  expect(screen.getByRole('switch', { name: 'read' })).toBeEnabled()
})

it('does not revive an old API incarnation after API A-B-A', async () => {
  const oldA = deferred<CapabilitySettingsSnapshot>()
  const oldB = deferred<CapabilitySettingsSnapshot>()
  const newA = deferred<CapabilitySettingsSnapshot>()
  const getA = vi.fn().mockReturnValueOnce(oldA.promise).mockReturnValueOnce(newA.promise)
  const getB = vi.fn(() => oldB.promise)
  const a = api(getA)
  const b = api(getB)
  const actionSlot = slot()
  window.pion = a
  const { rerender } = render(<CapabilitySettingsPage cwd="/a" actionSlot={actionSlot} />)
  await flush()
  window.pion = b
  rerender(<CapabilitySettingsPage cwd="/a" actionSlot={actionSlot} />)
  await flush()
  window.pion = a
  rerender(<CapabilitySettingsPage cwd="/a" actionSlot={actionSlot} />)
  await flush()
  expect(getA).toHaveBeenCalledTimes(1)
  await act(async () => { oldA.resolve(snapshot()); oldB.resolve(snapshot()) })
  expect(getA).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  await act(async () => newA.resolve(snapshot()))
  expect(screen.getByRole('switch', { name: 'read' })).toBeEnabled()
})

it('only polls pending/applying while visible, stops at settlement and never displays arbitrary diagnostics', async () => {
  vi.useFakeTimers()
  let visibility: DocumentVisibilityState = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  const state = (value: 'pending' | 'applying' | 'applied') => snapshot('/a', {
    notices: ['private catalogue diagnostic'],
    application: { state: value, requestedRevision: 4, pendingBackends: value === 'applied' ? 0 : 1, message: 'private application diagnostic' }
  })
  const get = vi.fn().mockResolvedValueOnce(state('pending')).mockResolvedValueOnce(state('applying'))
    .mockResolvedValueOnce(state('applied')).mockResolvedValue(state('pending'))
  const update = vi.fn()
  window.pion = api(get, update)
  const actionSlot = slot()
  const first = render(<CapabilitySettingsPage cwd="/a" actionSlot={actionSlot} />)
  await flush()
  expect(get).toHaveBeenCalledTimes(1)
  expect(screen.getByText('已保存，等待应用')).toBeInTheDocument()
  expect(screen.getByText(/待本轮真实结束后应用/)).toBeInTheDocument()
  expect(document.body).not.toHaveTextContent('private')
  await act(async () => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(5000) })
  expect(get).toHaveBeenCalledTimes(1)
  await act(async () => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')) })
  expect(get).toHaveBeenCalledTimes(2)
  expect(screen.getByText('正在应用')).toBeInTheDocument()
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(get).toHaveBeenCalledTimes(3)
  expect(screen.getByText('已应用')).toBeInTheDocument()
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(get).toHaveBeenCalledTimes(3)
  first.unmount()
  const second = render(<CapabilitySettingsPage cwd="/a" actionSlot={actionSlot} />)
  await flush()
  expect(get).toHaveBeenCalledTimes(4)
  second.unmount()
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(get).toHaveBeenCalledTimes(4)
  expect(update).not.toHaveBeenCalled()
})
