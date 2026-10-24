// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UsageCollectionSettings } from '../../src/renderer/src/features/settings/SessionPage'
import type { PionApi } from '../../src/shared/pion-api'

const descriptor = Object.getOwnPropertyDescriptor(window, 'pion')
afterEach(() => {
  cleanup()
  if (descriptor) Object.defineProperty(window, 'pion', descriptor)
  else delete (window as unknown as { pion?: unknown }).pion
})
const flush = async () => { await act(async () => { await Promise.resolve() }) }
function mock() {
  const api = {
    getUsageBackgroundCollection: vi.fn().mockResolvedValue(true),
    setUsageBackgroundCollection: vi.fn().mockResolvedValue(false)
  }
  window.pion = api as unknown as PionApi
  return api
}

it('loads before enabling the toggle and waits for persistence before changing it', async () => {
  const api = mock()
  let finish!: (value: boolean) => void
  api.setUsageBackgroundCollection.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  render(<UsageCollectionSettings />)
  const toggle = screen.getByRole('switch', { name: '后台自动采集' })
  expect(toggle).toBeDisabled()
  await flush()
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByText('关闭后不自动扫描，打开使用总览时补录')).toBeInTheDocument()
  fireEvent.click(toggle)
  await flush()
  expect(toggle).toBeDisabled()
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(api.setUsageBackgroundCollection).toHaveBeenCalledExactlyOnceWith(false)
  await act(async () => { finish(false) })
  expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect(toggle).not.toBeDisabled()
})

it('shows write errors without replacing the saved value', async () => {
  const api = mock()
  api.setUsageBackgroundCollection.mockRejectedValue(new Error('disk full'))
  render(<UsageCollectionSettings />)
  await flush()
  const toggle = screen.getByRole('switch', { name: '后台自动采集' })
  fireEvent.click(toggle)
  await flush()
  expect(screen.getByRole('alert')).toHaveTextContent('disk full')
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(toggle).not.toBeDisabled()
})

it('never writes a default when loading fails', async () => {
  const api = mock()
  api.getUsageBackgroundCollection.mockRejectedValue(new Error('read failed'))
  render(<UsageCollectionSettings />)
  await flush()
  expect(screen.getByRole('alert')).toHaveTextContent('read failed')
  expect(screen.getByRole('switch')).toBeDisabled()
  expect(api.setUsageBackgroundCollection).not.toHaveBeenCalled()
})

it('waits for an unmounted save before re-reading', async () => {
  const api = mock()
  let finish!: (value: boolean) => void
  api.setUsageBackgroundCollection.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const first = render(<UsageCollectionSettings />)
  await flush()
  fireEvent.click(screen.getByRole('switch'))
  await flush()
  first.unmount()
  api.getUsageBackgroundCollection.mockResolvedValue(false)
  render(<UsageCollectionSettings />)
  await flush()
  expect(screen.getByRole('switch')).toBeDisabled()
  expect(api.getUsageBackgroundCollection).toHaveBeenCalledTimes(1)
  await act(async () => { finish(false) })
  expect(api.getUsageBackgroundCollection).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
})
