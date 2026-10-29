// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentSettings } from '../../src/renderer/src/features/settings/SubagentSettings'
import { DEFAULT_SUBAGENT_SETTINGS, SUBAGENT_THINKING_LEVELS, validateSubagentSettings, type SubagentSettings as Settings } from '../../src/shared/subagents'
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
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('下一批'))
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'two', id: 'same' } })
  await waitFor(() => expect(select).toBeEnabled())
  fireEvent.click(select)
  fireEvent.click(screen.getByRole('option', { name: 'two/three' }))
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

it.each(['resolve', 'reject'] as const)('waits across repeated remounts for a real save to %s before reading fresh settings', async (outcome) => {
  let resolve!: (value: typeof DEFAULT_SUBAGENT_SETTINGS) => void
  let reject!: (reason: Error) => void
  const pending = new Promise<typeof DEFAULT_SUBAGENT_SETTINGS>((done, fail) => { resolve = done; reject = fail })
  const initial = { ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'saved', id: 'exact/model' } }
  const draft = { ...initial, maxParallel: 8 }
  let stored = initial
  const load = vi.fn(async () => stored)
  const save = vi.fn().mockReturnValueOnce(pending).mockImplementation(async (value) => value)
  window.pion = { getSubagentSettings: load, setSubagentSettings: save } as unknown as PionApi
  const first = render(<SubagentSettings />)
  await waitFor(() => expect(screen.getByRole('spinbutton', { name: '每批最大子代理数' })).toBeEnabled())
  fireEvent.change(screen.getByRole('spinbutton', { name: '每批最大子代理数' }), { target: { value: '8' } })
  fireEvent.submit(first.container.querySelector('form')!)
  expect(save).toHaveBeenCalledExactlyOnceWith(draft)
  first.unmount()
  const waiting = render(<SubagentSettings />)
  await act(async () => { await Promise.resolve() })
  expect(load).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: '等待上次保存结束…' })).toBeDisabled()
  fireEvent.submit(waiting.container.querySelector('form')!)
  expect(save).toHaveBeenCalledTimes(1)
  waiting.unmount()
  const reopened = render(<SubagentSettings />)
  await act(async () => { await Promise.resolve() })
  expect(load).toHaveBeenCalledTimes(1)
  const count = screen.getByRole('spinbutton', { name: '每批最大子代理数' })
  expect(count).toBeDisabled()
  await act(async () => {
    if (outcome === 'resolve') { stored = draft; resolve(draft) }
    else reject(new Error('disk write failed'))
  })
  await waitFor(() => expect(count).toBeEnabled())
  expect(load).toHaveBeenCalledTimes(2)
  expect(count).toHaveValue(8)
  expect(screen.getByRole('combobox', { name: '默认子代理模型' })).toHaveTextContent('saved/exact/model（当前列表未显示）')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  if (outcome === 'reject') expect(screen.getByRole('alert')).toHaveTextContent('保存失败：Error: disk write failed')
  else expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(save).toHaveBeenCalledTimes(1)
  reopened.unmount()
  const returned = render(<SubagentSettings />)
  await waitFor(() => expect(screen.getByRole('spinbutton', { name: '每批最大子代理数' })).toBeEnabled())
  expect(screen.getByRole('spinbutton', { name: '每批最大子代理数' })).toHaveValue(8)
  expect(load).toHaveBeenCalledTimes(3)
  if (outcome === 'reject') expect(screen.getByRole('alert')).toHaveTextContent('disk write failed')
  fireEvent.submit(returned.container.querySelector('form')!)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('下一批'))
  expect(save).toHaveBeenLastCalledWith(draft)
  expect(save).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it.each(['resolve', 'reject'] as const)('isolates API replacement while an old owner save %s settles', async (outcome) => {
  let resolve!: (value: typeof DEFAULT_SUBAGENT_SETTINGS) => void
  let reject!: (reason: Error) => void
  const pending = new Promise<typeof DEFAULT_SUBAGENT_SETTINGS>((done, fail) => { resolve = done; reject = fail })
  const oldSave = vi.fn().mockReturnValue(pending)
  const oldLoad = vi.fn().mockResolvedValue(DEFAULT_SUBAGENT_SETTINGS)
  const oldApi = { getSubagentSettings: oldLoad, setSubagentSettings: oldSave } as unknown as PionApi
  window.pion = oldApi
  const { container, rerender } = render(<SubagentSettings />)
  const count = screen.getByRole('spinbutton', { name: '每批最大子代理数' })
  await waitFor(() => expect(count).toBeEnabled())
  fireEvent.change(count, { target: { value: '8' } })
  fireEvent.submit(container.querySelector('form')!)
  let resolveNew!: (value: typeof DEFAULT_SUBAGENT_SETTINGS) => void
  const save = vi.fn(() => new Promise<typeof DEFAULT_SUBAGENT_SETTINGS>((done) => { resolveNew = done }))
  let storedNew = { ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 4 }
  const newLoad = vi.fn(async () => storedNew)
  const newApi = { getSubagentSettings: newLoad, setSubagentSettings: save } as unknown as PionApi
  window.pion = newApi
  rerender(<SubagentSettings />)
  await waitFor(() => expect(count).toBeEnabled())
  expect(count).toHaveValue(4)
  fireEvent.change(count, { target: { value: '5' } })
  fireEvent.submit(container.querySelector('form')!)
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 5 })
  expect(count).toBeDisabled()
  window.pion = oldApi
  rerender(<SubagentSettings />)
  expect(count).toHaveValue(8)
  expect(count).toBeDisabled()
  expect(oldLoad).toHaveBeenCalledTimes(1)
  window.pion = newApi
  rerender(<SubagentSettings />)
  expect(count).toHaveValue(5)
  expect(count).toBeDisabled()
  expect(newLoad).toHaveBeenCalledTimes(1)
  await act(async () => {
    if (outcome === 'resolve') resolve({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 8 })
    else reject(new Error('old owner failure'))
  })
  expect(count).toHaveValue(5)
  expect(count).toBeDisabled()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  fireEvent.submit(container.querySelector('form')!)
  expect(save).toHaveBeenCalledTimes(1)
  await act(async () => { storedNew = { ...storedNew, maxParallel: 5 }; resolveNew(storedNew) })
  await waitFor(() => expect(count).toBeEnabled())
  expect(count).toHaveValue(5)
  expect(newLoad).toHaveBeenCalledTimes(2)
  expect(oldLoad).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(oldSave).toHaveBeenCalledTimes(1)
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

it.each(['read error', 'invalid thinking'] as const)('requires a successful read before any write after %s', async (reason) => {
  const saved = { ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 7, defaultThinkingLevel: 'max' as const }
  const load = reason === 'read error'
    ? vi.fn().mockRejectedValueOnce(new Error('invalid config')).mockResolvedValue(saved)
    : vi.fn().mockResolvedValueOnce({ ...saved, defaultThinkingLevel: 'invalid' }).mockResolvedValue(saved)
  const save = vi.fn(async (value: Settings) => value)
  window.pion = { getSubagentSettings: load, setSubagentSettings: save } as unknown as PionApi
  const { container } = render(<SubagentSettings models={[{ provider: 'chosen', id: 'model' }]} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败，已有配置保持不变，请重试')
  expect(screen.getByRole('combobox', { name: '默认子代理模型' })).toBeDisabled()
  expect(screen.getByRole('combobox', { name: '默认子代理思考等级' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '恢复默认值' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '保存子代理设置' })).toBeDisabled()
  fireEvent.submit(container.querySelector('form')!)
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重试读取子代理设置' }))
  await waitFor(() => expect(screen.getByRole('spinbutton', { name: '每批最大子代理数' })).toBeEnabled())
  expect(screen.getByRole('spinbutton', { name: '每批最大子代理数' })).toHaveValue(7)
  expect(screen.getByRole('combobox', { name: '默认子代理思考等级' })).toHaveTextContent('max')
  expect(load).toHaveBeenCalledTimes(2)
  expect(save).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('restores both automatic selections through persisted storage and a fresh API after remount', async () => {
  let stored = JSON.stringify(DEFAULT_SUBAGENT_SETTINGS)
  const makeApi = () => ({
    getSubagentSettings: vi.fn(async () => JSON.parse(stored)),
    setSubagentSettings: vi.fn(async (value: Settings) => {
      const saved = validateSubagentSettings(value)
      stored = JSON.stringify(saved)
      return saved
    })
  })
  const firstApi = makeApi()
  window.pion = firstApi as unknown as PionApi
  const first = render(<SubagentSettings models={[{ provider: 'exact', id: 'child', name: 'Child' }]} />)
  const model = screen.getByRole('combobox', { name: '默认子代理模型' })
  await waitFor(() => expect(model).toBeEnabled())
  fireEvent.click(model)
  fireEvent.click(screen.getByRole('option', { name: 'Child' }))
  await waitFor(() => expect(model).toBeEnabled())
  const thinking = screen.getByRole('combobox', { name: '默认子代理思考等级' })
  fireEvent.click(thinking)
  fireEvent.click(screen.getByRole('option', { name: 'xhigh' }))
  await waitFor(() => expect(thinking).toBeEnabled())
  expect(firstApi.setSubagentSettings).toHaveBeenCalledTimes(2)
  expect(JSON.parse(stored)).toEqual({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'exact', id: 'child' }, defaultThinkingLevel: 'xhigh' })
  first.unmount()
  const nextApi = makeApi()
  window.pion = nextApi as unknown as PionApi
  render(<SubagentSettings />)
  await waitFor(() => expect(screen.getByRole('combobox', { name: '默认子代理模型' })).toBeEnabled())
  expect(screen.getByRole('combobox', { name: '默认子代理模型' })).toHaveTextContent('exact/child（当前列表未显示）')
  expect(screen.getByRole('combobox', { name: '默认子代理思考等级' })).toHaveTextContent('xhigh')
  expect(nextApi.getSubagentSettings).toHaveBeenCalledOnce()
  expect(nextApi.setSubagentSettings).not.toHaveBeenCalled()
})

it('automatically saves only baseline numbers and keeps invalid numeric drafts until an explicit validated save', async () => {
  const save = vi.fn(async (value: Settings) => value)
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(DEFAULT_SUBAGENT_SETTINGS), setSubagentSettings: save } as unknown as PionApi
  const { container } = render(<SubagentSettings models={[{ provider: 'one', id: 'child' }]} />)
  const count = screen.getByRole('spinbutton', { name: '每批最大子代理数' })
  const model = screen.getByRole('combobox', { name: '默认子代理模型' })
  await waitFor(() => expect(count).toBeEnabled())
  fireEvent.change(count, { target: { value: '101' } })
  fireEvent.click(model)
  fireEvent.click(screen.getByRole('option', { name: 'child' }))
  await waitFor(() => expect(model).toBeEnabled())
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'one', id: 'child' } })
  expect(count).toHaveValue(101)
  // Automatic replies update selections without submitting or replacing numeric drafts.
  expect(screen.getByRole('spinbutton', { name: '每个子代理最多轮数' })).toHaveValue(24)
  fireEvent.click(screen.getByRole('combobox', { name: '默认子代理思考等级' }))
  fireEvent.click(screen.getByRole('option', { name: 'high' }))
  await waitFor(() => expect(count).toBeEnabled())
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'one', id: 'child' }, defaultThinkingLevel: 'high' })
  expect(count).toHaveValue(101)
  fireEvent.submit(container.querySelector('form')!)
  expect(save).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('alert')).toHaveTextContent('1–100')
  fireEvent.change(count, { target: { value: '9' } })
  fireEvent.submit(container.querySelector('form')!)
  await waitFor(() => expect(count).toBeEnabled())
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENT_SETTINGS, maxParallel: 9, defaultModel: { provider: 'one', id: 'child' }, defaultThinkingLevel: 'high' })
  expect(screen.getByRole('spinbutton', { name: '每个子代理最多轮数' })).toHaveValue(24)
})

it.each(['auto', 'manual'] as const)('retains %s selections across remount when the save receipt disagrees, then permits explicit retry', async (kind) => {
  const stored: Settings = { ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'exact', id: 'child' } }
  const save = vi.fn().mockImplementationOnce(async (value: Settings) => kind === 'auto'
    ? { ...value, defaultThinkingLevel: null }
    : { ...value, defaultModel: { provider: 'other', id: 'wrong' } })
    .mockImplementation(async (value: Settings) => value)
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(stored), setSubagentSettings: save } as unknown as PionApi
  const first = render(<SubagentSettings />)
  await waitFor(() => expect(screen.getByRole('spinbutton', { name: '每批最大子代理数' })).toBeEnabled())
  if (kind === 'auto') {
    fireEvent.click(screen.getByRole('combobox', { name: '默认子代理思考等级' }))
    fireEvent.click(screen.getByRole('option', { name: 'high' }))
  } else {
    fireEvent.change(screen.getByRole('spinbutton', { name: '每批最大子代理数' }), { target: { value: '4' } })
    fireEvent.submit(first.container.querySelector('form')!)
  }
  first.unmount()
  render(<SubagentSettings />)
  await waitFor(() => expect(screen.getByRole('spinbutton', { name: '每批最大子代理数' })).toBeEnabled())
  expect(screen.getByRole('alert')).toHaveTextContent('保存回执与提交配置不一致')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: '默认子代理模型' })).toHaveTextContent('exact/child')
  expect(screen.getByRole('combobox', { name: '默认子代理思考等级' })).toHaveTextContent(kind === 'auto' ? 'high' : '继承主会话思考等级')
  expect(screen.getByRole('spinbutton', { name: '每批最大子代理数' })).toHaveValue(kind === 'auto' ? 3 : 4)
  fireEvent.click(screen.getByRole('button', { name: kind === 'auto' ? '重试保存模型与思考等级' : '保存子代理设置' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('下一批'))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(save).toHaveBeenCalledTimes(2)
  expect(save).toHaveBeenLastCalledWith({ ...stored, maxParallel: kind === 'auto' ? 3 : 4, defaultThinkingLevel: kind === 'auto' ? 'high' : null })
})

it('offers the shared thinking whitelist and null inheritance while the independent model directory is pending', async () => {
  const { defaultModel: _model, defaultThinkingLevel: _thinking, ...legacy } = DEFAULT_SUBAGENT_SETTINGS
  const save = vi.fn(async (value: Settings) => validateSubagentSettings(value))
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(legacy), setSubagentSettings: save,
    getSubagentModels: vi.fn(() => new Promise(() => {})) } as unknown as PionApi
  render(<SubagentSettings models={[{ provider: 'parent', id: 'limited', reasoning: false }]} />)
  const thinking = screen.getByRole('combobox', { name: '默认子代理思考等级' })
  await waitFor(() => expect(thinking).toBeEnabled())
  expect(screen.getByRole('combobox', { name: '默认子代理模型' })).toBeDisabled()
  expect(thinking).toHaveTextContent('继承主会话思考等级')
  fireEvent.click(thinking)
  expect(screen.getAllByRole('option')).toHaveLength(SUBAGENT_THINKING_LEVELS.length + 1)
  for (const level of SUBAGENT_THINKING_LEVELS) expect(screen.getByRole('option', { name: level, exact: true })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('option', { name: 'max', exact: true }))
  await waitFor(() => expect(thinking).toBeEnabled())
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultThinkingLevel: 'max' })
  fireEvent.click(thinking)
  fireEvent.click(screen.getByRole('option', { name: '继承主会话思考等级' }))
  await waitFor(() => expect(thinking).toBeEnabled())
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultThinkingLevel: null })
  expect(save).toHaveBeenCalledTimes(2)
})

it.each(['resolve', 'reject'] as const)('retains automatic drafts across closed pending saves that %s and retries without submitting numeric drafts', async (outcome) => {
  let resolve!: (value: Settings) => void
  let reject!: (reason: Error) => void
  let stored = { ...DEFAULT_SUBAGENT_SETTINGS }
  const pending = new Promise<Settings>((done, fail) => { resolve = done; reject = fail })
  const save = vi.fn().mockReturnValueOnce(pending).mockImplementation(async (value: Settings) => {
    stored = validateSubagentSettings(value)
    return stored
  })
  const load = vi.fn(async () => stored)
  window.pion = { getSubagentSettings: load, setSubagentSettings: save } as unknown as PionApi
  const first = render(<SubagentSettings models={[{ provider: 'one', id: 'child' }]} />)
  await waitFor(() => expect(screen.getByRole('spinbutton', { name: '每批最大子代理数' })).toBeEnabled())
  fireEvent.change(screen.getByRole('spinbutton', { name: '每批最大子代理数' }), { target: { value: '8' } })
  fireEvent.click(screen.getByRole('combobox', { name: '默认子代理模型' }))
  fireEvent.click(screen.getByRole('option', { name: 'child' }))
  const submitted = { ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'one', id: 'child' } }
  expect(save).toHaveBeenCalledExactlyOnceWith(submitted)
  // A repeated manual dispatch in the same pending slot has no effect.
  fireEvent.submit(first.container.querySelector('form')!)
  expect(save).toHaveBeenCalledTimes(1)
  first.unmount()
  const waiting = render(<SubagentSettings />)
  expect(screen.getByRole('button', { name: '等待上次保存结束…' })).toBeDisabled()
  fireEvent.submit(waiting.container.querySelector('form')!)
  expect(load).toHaveBeenCalledTimes(1)
  waiting.unmount()
  const reopened = render(<SubagentSettings />)
  await act(async () => {
    if (outcome === 'resolve') { stored = submitted; resolve(submitted) }
    else reject(new Error('automatic write failed'))
  })
  await waitFor(() => expect(screen.getByRole('spinbutton', { name: '每批最大子代理数' })).toBeEnabled())
  expect(screen.getByRole('spinbutton', { name: '每批最大子代理数' })).toHaveValue(8)
  expect(screen.getByRole('combobox', { name: '默认子代理模型' })).toHaveTextContent('one/child（当前列表未显示）')
  expect(load).toHaveBeenCalledTimes(2)
  expect(save).toHaveBeenCalledTimes(1)
  expect(stored.maxParallel).toBe(3)
  if (outcome === 'reject') {
    expect(screen.getByRole('alert')).toHaveTextContent('automatic write failed')
    reopened.unmount()
    render(<SubagentSettings />)
    const count = screen.getByRole('spinbutton', { name: '每批最大子代理数' })
    await waitFor(() => expect(count).toBeEnabled())
    expect(count).toHaveValue(8)
    expect(screen.getByRole('alert')).toHaveTextContent('automatic write failed')
    fireEvent.change(count, { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: '重试保存模型与思考等级' }))
    await waitFor(() => expect(count).toBeEnabled())
    expect(save).toHaveBeenLastCalledWith(submitted)
    expect(count).toHaveValue(9)
    expect(stored.maxParallel).toBe(3)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  }
})
})
