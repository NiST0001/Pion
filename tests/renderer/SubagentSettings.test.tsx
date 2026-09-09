// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SubagentSettings } from '../../src/renderer/src/features/settings/SubagentSettings'
import { DEFAULT_SUBAGENT_SETTINGS } from '../../src/shared/subagents'
import type { PionApi } from '../../src/shared/pion-api'

afterEach(() => { delete (window as unknown as { pion?: unknown }).pion })

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
