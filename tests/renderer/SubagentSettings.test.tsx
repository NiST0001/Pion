// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentSettings } from '../../src/renderer/src/features/settings/SubagentSettings'
import { DEFAULT_SUBAGENT_SETTINGS } from '../../src/shared/subagents'
import type { PionApi } from '../../src/shared/pion-api'

describe('SubagentSettings', () => {
let originalApi: PropertyDescriptor | undefined
beforeEach(() => { originalApi = Object.getOwnPropertyDescriptor(window, 'pion') })
afterEach(() => {
  cleanup()
  if (originalApi) Object.defineProperty(window, 'pion', originalApi)
  else delete (window as unknown as { pion?: unknown }).pion
})

it('loads defaults, saves global limits once and explicitly reports next-batch application', async () => {
  let resolve!: (value: typeof DEFAULT_SUBAGENT_SETTINGS) => void
  const save = vi.fn(() => new Promise((done) => { resolve = done }))
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(DEFAULT_SUBAGENT_SETTINGS), setSubagentSettings: save } as unknown as PionApi
  const { container } = render(<SubagentSettings />)
  const count = screen.getByRole('spinbutton', { name: '每批最大子代理数' })
  await waitFor(() => expect(count).toBeEnabled())
  expect(count).toHaveValue(3)
  fireEvent.change(count, { target: { value: '5' } })
  fireEvent.submit(container.querySelector('form')!)
  fireEvent.submit(container.querySelector('form')!)
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 5 })
  expect(count).toBeDisabled()
  await act(async () => resolve({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 5 }))
  expect(screen.getByRole('status')).toHaveTextContent('下一批')
  expect(count).toBeEnabled()
})

it('offers and saves 1000 turns while rejecting 1001 without changing the default', async () => {
  const save = vi.fn(async (value: typeof DEFAULT_SUBAGENT_SETTINGS) => value)
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(DEFAULT_SUBAGENT_SETTINGS), setSubagentSettings: save } as unknown as PionApi
  const { container } = render(<SubagentSettings />)
  const turns = screen.getByRole('spinbutton', { name: '每个子代理最多轮数' })
  await waitFor(() => expect(turns).toBeEnabled())
  expect(turns).toHaveValue(24)
  expect(turns).toHaveAttribute('max', '1000')
  fireEvent.change(turns, { target: { value: '1001' } })
  fireEvent.submit(container.querySelector('form')!)
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('1–1000')
  fireEvent.change(turns, { target: { value: '1000' } })
  fireEvent.submit(container.querySelector('form')!)
  await waitFor(() => expect(save).toHaveBeenCalledWith({ ...DEFAULT_SUBAGENT_SETTINGS, maxTurns: 1000 }))
})

it('rejects invalid values and preserves editable values after a save failure', async () => {
  const save = vi.fn().mockRejectedValue(new Error('磁盘写入失败'))
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(DEFAULT_SUBAGENT_SETTINGS), setSubagentSettings: save } as unknown as PionApi
  const { container } = render(<SubagentSettings />)
  const count = screen.getByRole('spinbutton', { name: '每批最大子代理数' })
  await waitFor(() => expect(count).toBeEnabled())
  fireEvent.change(count, { target: { value: '101' } })
  fireEvent.submit(container.querySelector('form')!)
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('1–100')
  fireEvent.change(count, { target: { value: '4' } })
  fireEvent.submit(container.querySelector('form')!)
  expect(await screen.findByRole('alert')).toHaveTextContent('磁盘写入失败')
  expect(count).toHaveValue(4)
  expect(count).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '恢复默认值' }))
  expect(count).toHaveValue(3)
  expect(screen.getByRole('status')).toHaveTextContent('请保存')
  expect(save).toHaveBeenCalledTimes(1)
})

it('normalizes legacy settings to inherit and saves exact provider/id without model or backend calls', async () => {
  const { defaultModel: _defaultModel, ...legacy } = DEFAULT_SUBAGENT_SETTINGS
  const save = vi.fn().mockImplementation(async (settings) => settings)
  const getAvailableModels = vi.fn()
  const setModel = vi.fn()
  const startAgent = vi.fn()
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(legacy), setSubagentSettings: save,
    getAvailableModels, setModel, startAgent } as unknown as PionApi
  const { container } = render(<SubagentSettings models={[
    { provider: 'one', id: 'same', name: 'Same One' },
    { provider: 'one', id: 'same', name: 'Duplicate Same One' },
    { provider: 'two', id: 'same', name: 'Same Two' },
    { provider: 'one/two', id: 'three' },
    { provider: 'one', id: 'two/three' }
  ]} />)
  const select = screen.getByRole('combobox', { name: '默认子代理模型' })
  await waitFor(() => expect(select).toBeEnabled())
  expect(select).toHaveTextContent('继承主会话模型')
  expect(container.querySelector('select')).not.toBeInTheDocument()
  fireEvent.click(select)
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('listbox')).toBeInTheDocument()
  expect(screen.getByRole('group', { name: 'two' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'Same One' })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: 'Duplicate Same One' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('option', { name: 'Same Two' }))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '保存子代理设置' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('下一批'))
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'two', id: 'same' } })
  await waitFor(() => expect(select).toBeEnabled())
  fireEvent.click(select)
  fireEvent.click(screen.getByRole('option', { name: 'two/three' }))
  fireEvent.click(screen.getByRole('button', { name: '保存子代理设置' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'one', id: 'two/three' } })
  await waitFor(() => expect(select).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '恢复默认值' }))
  expect(select).toHaveTextContent('继承主会话模型')
  expect(screen.getByRole('status')).toHaveTextContent('请保存')
  expect(save).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: '保存子代理设置' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(3))
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: null })
  expect(getAvailableModels).not.toHaveBeenCalled()
  expect(setModel).not.toHaveBeenCalled()
  expect(startAgent).not.toHaveBeenCalled()
})

it('preserves a saved selection absent from the visible candidates, including on failed save', async () => {
  const saved = { ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'hidden', id: 'private/model' } }
  const save = vi.fn().mockRejectedValue(new Error('write failed'))
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(saved), setSubagentSettings: save } as unknown as PionApi
  const { rerender } = render(<SubagentSettings models={[{ provider: 'visible', id: 'other' }]} />)
  const select = screen.getByRole('combobox', { name: '默认子代理模型' })
  await waitFor(() => expect(select).toBeEnabled())
  expect(select).toHaveTextContent('hidden/private/model（当前列表未显示）')
  fireEvent.click(select)
  expect(screen.getByRole('option', { name: 'hidden/private/model（当前列表未显示）' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(screen.getByRole('option', { name: 'hidden/private/model（当前列表未显示）' }))
  rerender(<SubagentSettings models={[]} />)
  expect(select).toHaveTextContent('hidden/private/model（当前列表未显示）')
  expect(screen.queryByText(/不可用/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '保存子代理设置' }))
  await waitFor(() => expect(select).toBeEnabled())
  expect(screen.getByRole('alert')).toHaveTextContent('write failed')
  expect(select).toHaveTextContent('hidden/private/model（当前列表未显示）')
  expect(save).toHaveBeenCalledExactlyOnceWith(saved)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('ignores a previous owner load after the new owner has loaded and edited its draft', async () => {
  let resolve!: (value: typeof DEFAULT_SUBAGENT_SETTINGS) => void
  const oldLoad = new Promise<typeof DEFAULT_SUBAGENT_SETTINGS>((done) => { resolve = done })
  window.pion = { getSubagentSettings: vi.fn().mockReturnValue(oldLoad), setSubagentSettings: vi.fn() } as unknown as PionApi
  const { rerender } = render(<SubagentSettings />)
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(DEFAULT_SUBAGENT_SETTINGS), setSubagentSettings: vi.fn() } as unknown as PionApi
  rerender(<SubagentSettings />)
  const count = screen.getByRole('spinbutton', { name: '每批最大子代理数' })
  await waitFor(() => expect(count).toBeEnabled())
  fireEvent.change(count, { target: { value: '6' } })
  await act(async () => resolve({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 8 }))
  expect(count).toHaveValue(6)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it.each(['resolve', 'reject'] as const)('keeps the real save slot until stale owner save %s settles', async (outcome) => {
  let resolve!: (value: typeof DEFAULT_SUBAGENT_SETTINGS) => void
  let reject!: (reason: Error) => void
  const pending = new Promise<typeof DEFAULT_SUBAGENT_SETTINGS>((done, fail) => { resolve = done; reject = fail })
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(DEFAULT_SUBAGENT_SETTINGS), setSubagentSettings: vi.fn().mockReturnValue(pending) } as unknown as PionApi
  const { container, rerender } = render(<SubagentSettings />)
  const count = screen.getByRole('spinbutton', { name: '每批最大子代理数' })
  await waitFor(() => expect(count).toBeEnabled())
  fireEvent.change(count, { target: { value: '8' } })
  fireEvent.submit(container.querySelector('form')!)
  const save = vi.fn().mockImplementation(async (settings) => settings)
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 4 }), setSubagentSettings: save } as unknown as PionApi
  rerender(<SubagentSettings />)
  await waitFor(() => expect(count).toHaveValue(4))
  expect(count).toBeDisabled()
  fireEvent.submit(container.querySelector('form')!)
  expect(save).not.toHaveBeenCalled()
  await act(async () => {
    if (outcome === 'resolve') resolve({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 8 })
    else reject(new Error('old owner failure'))
  })
  expect(count).toHaveValue(4)
  expect(count).toBeEnabled()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  fireEvent.submit(container.querySelector('form')!)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('下一批'))
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 4 })
})

it('uses the independent SDK directory with empty or stale parent candidates', async () => {
  const getSubagentModels = vi.fn().mockResolvedValue([{ provider: 'configured', id: 'child', name: 'SDK Child' }])
  const getAvailableModels = vi.fn()
  const save = vi.fn().mockImplementation(async (settings) => settings)
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(DEFAULT_SUBAGENT_SETTINGS),
    setSubagentSettings: save, getSubagentModels, getAvailableModels } as unknown as PionApi
  const { rerender } = render(<SubagentSettings models={[]} />)
  const select = screen.getByRole('combobox', { name: '默认子代理模型' })
  await waitFor(() => expect(select).toBeEnabled())
  fireEvent.click(select)
  expect(screen.getByRole('option', { name: 'SDK Child' })).toBeInTheDocument()
  rerender(<SubagentSettings models={[{ provider: 'stale', id: 'parent' }]} />)
  expect(screen.queryByRole('option', { name: 'parent' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('option', { name: 'SDK Child' }))
  fireEvent.click(screen.getByRole('button', { name: '保存子代理设置' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'configured', id: 'child' } }))
  expect(getSubagentModels).toHaveBeenCalledOnce()
  expect(getAvailableModels).not.toHaveBeenCalled()
})

it.each(['resolve', 'reject'] as const)('ignores old owner directory %s after the new owner loads', async (outcome) => {
  let resolve!: (models: { provider: string; id: string }[]) => void
  let reject!: (reason: Error) => void
  const pending = new Promise<{ provider: string; id: string }[]>((done, fail) => { resolve = done; reject = fail })
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(DEFAULT_SUBAGENT_SETTINGS),
    setSubagentSettings: vi.fn(), getSubagentModels: vi.fn().mockReturnValue(pending) } as unknown as PionApi
  const { rerender } = render(<SubagentSettings />)
  const saved = { ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'new', id: 'child' } }
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(saved), setSubagentSettings: vi.fn(),
    getSubagentModels: vi.fn().mockResolvedValue([{ provider: 'new', id: 'child' }]) } as unknown as PionApi
  rerender(<SubagentSettings />)
  const select = screen.getByRole('combobox', { name: '默认子代理模型' })
  await waitFor(() => expect(select).toBeEnabled())
  await act(async () => { if (outcome === 'resolve') resolve([{ provider: 'old', id: 'stale' }]); else reject(new Error('old failure')) })
  expect(select).toHaveTextContent('child')
  fireEvent.click(select)
  expect(screen.getByRole('option', { name: 'child' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.queryByRole('option', { name: 'stale' })).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('reports independent directory failure without replacing a saved default or using parent candidates', async () => {
  const saved = { ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'saved', id: 'child' } }
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(saved), setSubagentSettings: vi.fn(),
    getSubagentModels: vi.fn().mockRejectedValue(new Error('private details')) } as unknown as PionApi
  render(<SubagentSettings models={[{ provider: 'parent', id: 'stale' }]} />)
  const select = screen.getByRole('combobox', { name: '默认子代理模型' })
  await waitFor(() => expect(select).toBeEnabled())
  expect(select).toHaveTextContent('saved/child（当前列表未显示）')
  fireEvent.click(select)
  expect(screen.getByRole('option', { name: 'saved/child（当前列表未显示）' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('alert')).toHaveTextContent('读取模型目录失败')
  expect(screen.getByRole('alert')).not.toHaveTextContent('private details')
  expect(screen.queryByRole('option', { name: 'stale' })).not.toBeInTheDocument()
})

it('bounds directory waiting and ignores a response after the deadline', async () => {
  vi.useFakeTimers()
  try {
    let resolve!: (models: { provider: string; id: string }[]) => void
    const pending = new Promise<{ provider: string; id: string }[]>((done) => { resolve = done })
    window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(DEFAULT_SUBAGENT_SETTINGS), setSubagentSettings: vi.fn(),
      getSubagentModels: vi.fn().mockReturnValue(pending) } as unknown as PionApi
    render(<SubagentSettings />)
    await act(async () => { await Promise.resolve() })
    const select = screen.getByRole('combobox', { name: '默认子代理模型' })
    expect(select).toBeDisabled()
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(select).toBeEnabled()
    expect(screen.getByRole('alert')).toHaveTextContent('超时')
    await act(async () => resolve([{ provider: 'late', id: 'ignored' }]))
    fireEvent.click(select)
    expect(screen.getByRole('option', { name: '继承主会话模型' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'ignored' })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('超时')
  } finally { vi.useRealTimers() }
})

it('reports an empty independent directory instead of silently showing only inheritance', async () => {
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(DEFAULT_SUBAGENT_SETTINGS), setSubagentSettings: vi.fn(),
    getSubagentModels: vi.fn().mockResolvedValue([]) } as unknown as PionApi
  render(<SubagentSettings />)
  expect(await screen.findByText(/暂无已配置的可用模型/)).toBeInTheDocument()
})

it('allows explicit repair after a load failure without automatically saving defaults', async () => {
  const save = vi.fn().mockImplementation(async (settings) => settings)
  window.pion = { getSubagentSettings: vi.fn().mockRejectedValue(new Error('invalid config')), setSubagentSettings: save } as unknown as PionApi
  render(<SubagentSettings models={[{ provider: 'chosen', id: 'model' }]} />)
  const select = screen.getByRole('combobox', { name: '默认子代理模型' })
  await waitFor(() => expect(select).toBeEnabled())
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('可修改后保存以修复')
  fireEvent.click(select)
  fireEvent.click(screen.getByRole('option', { name: 'model' }))
  fireEvent.click(screen.getByRole('button', { name: '保存子代理设置' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('下一批'))
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'chosen', id: 'model' } })
})
})
