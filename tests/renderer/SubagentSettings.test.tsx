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

it('rejects invalid values and preserves editable values after a save failure', async () => {
  const save = vi.fn().mockRejectedValue(new Error('磁盘写入失败'))
  window.pion = { getSubagentSettings: vi.fn().mockResolvedValue(DEFAULT_SUBAGENT_SETTINGS), setSubagentSettings: save } as unknown as PionApi
  const { container } = render(<SubagentSettings />)
  const count = screen.getByRole('spinbutton', { name: '每批最大子代理数' })
  await waitFor(() => expect(count).toBeEnabled())
  fireEvent.change(count, { target: { value: '9' } })
  fireEvent.submit(container.querySelector('form')!)
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('1–8')
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
  render(<SubagentSettings models={[
    { provider: 'one', id: 'same', name: 'Same One' },
    { provider: 'two', id: 'same', name: 'Same Two' },
    { provider: 'one/two', id: 'three' },
    { provider: 'one', id: 'two/three' }
  ]} />)
  const select = screen.getByRole('combobox', { name: '默认子代理模型' })
  await waitFor(() => expect(select).toBeEnabled())
  expect(select).toHaveValue('inherit')
  expect(screen.getByRole('group', { name: 'two' })).toBeInTheDocument()
  fireEvent.change(select, { target: { value: JSON.stringify(['two', 'same']) } })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '保存子代理设置' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('下一批'))
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'two', id: 'same' } })
  fireEvent.change(select, { target: { value: JSON.stringify(['one', 'two/three']) } })
  fireEvent.click(screen.getByRole('button', { name: '保存子代理设置' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'one', id: 'two/three' } })
  await waitFor(() => expect(select).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '恢复默认值' }))
  expect(select).toHaveValue('inherit')
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
  const value = JSON.stringify(['hidden', 'private/model'])
  expect(select).toHaveValue(value)
  expect(screen.getByRole('option', { name: 'hidden/private/model（当前列表未显示）' })).toBeInTheDocument()
  rerender(<SubagentSettings models={[]} />)
  expect(select).toHaveValue(value)
  expect(screen.queryByText(/不可用/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '保存子代理设置' }))
  await waitFor(() => expect(select).toBeEnabled())
  expect(screen.getByRole('alert')).toHaveTextContent('write failed')
  expect(select).toHaveValue(value)
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

it('allows explicit repair after a load failure without automatically saving defaults', async () => {
  const save = vi.fn().mockImplementation(async (settings) => settings)
  window.pion = { getSubagentSettings: vi.fn().mockRejectedValue(new Error('invalid config')), setSubagentSettings: save } as unknown as PionApi
  render(<SubagentSettings models={[{ provider: 'chosen', id: 'model' }]} />)
  const select = screen.getByRole('combobox', { name: '默认子代理模型' })
  await waitFor(() => expect(select).toBeEnabled())
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('可修改后保存以修复')
  fireEvent.change(select, { target: { value: JSON.stringify(['chosen', 'model']) } })
  fireEvent.click(screen.getByRole('button', { name: '保存子代理设置' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('下一批'))
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_SUBAGENT_SETTINGS, defaultModel: { provider: 'chosen', id: 'model' } })
})
})
