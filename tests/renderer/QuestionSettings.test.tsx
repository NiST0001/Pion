// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QuestionSettings } from '../../src/renderer/src/features/settings/QuestionSettings'
import type { PionApi } from '../../src/shared/pion-api'
import type { QuestionSettings as Settings } from '../../src/shared/question-settings'

let originalApi: PropertyDescriptor | undefined
beforeEach(() => { originalApi = Object.getOwnPropertyDescriptor(window, 'pion') })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  if (originalApi) Object.defineProperty(window, 'pion', originalApi)
  else delete (window as unknown as { pion?: unknown }).pion
})
function api(get = vi.fn().mockResolvedValue({ timeoutMinutes: 10 }), set = vi.fn().mockImplementation(async (value) => value)) {
  return { getQuestionSettings: get, setQuestionSettings: set } as unknown as PionApi
}

it('loads defaults, saves finite and unlimited waits and reports next-question semantics', async () => {
  const set = vi.fn().mockImplementation(async (value) => value)
  window.pion = api(undefined, set)
  render(<QuestionSettings />)
  const minutes = screen.getByRole('spinbutton', { name: 'AI 提问等待时间（分钟）' })
  await waitFor(() => expect(minutes).toBeEnabled())
  expect(minutes).toHaveValue(10)
  fireEvent.change(minutes, { target: { value: '300' } })
  fireEvent.click(screen.getByRole('button', { name: '保存提问设置' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('下一次 AI 提问生效'))
  expect(set).toHaveBeenLastCalledWith({ timeoutMinutes: 300 })
  fireEvent.click(screen.getByRole('checkbox', { name: 'AI 提问不自动超时' }))
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  expect(screen.getByText(/仍可在问题面板手动取消/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '保存提问设置' }))
  await waitFor(() => expect(set).toHaveBeenLastCalledWith({ timeoutMinutes: null }))
})

it('validates limits, deduplicates saves, and retains the draft on failure', async () => {
  let reject!: (reason: Error) => void
  const set = vi.fn(() => new Promise<Settings>((_, fail) => { reject = fail }))
  window.pion = api(undefined, set)
  const { container } = render(<QuestionSettings />)
  const minutes = screen.getByRole('spinbutton')
  await waitFor(() => expect(minutes).toBeEnabled())
  fireEvent.change(minutes, { target: { value: '301' } })
  fireEvent.submit(container.querySelector('form')!)
  expect(set).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('1–300')
  fireEvent.change(minutes, { target: { value: '25' } })
  fireEvent.submit(container.querySelector('form')!)
  fireEvent.submit(container.querySelector('form')!)
  expect(set).toHaveBeenCalledTimes(1)
  expect(minutes).toBeDisabled()
  await act(async () => reject(new Error('disk failure')))
  expect(screen.getByRole('alert')).toHaveTextContent('保存失败')
  expect(minutes).toHaveValue(25)
  expect(minutes).toBeEnabled()
})

it('isolates late reads and saves after owner/API changes', async () => {
  let loadA!: (value: Settings) => void
  let saveA!: (value: Settings) => void
  const a = api(vi.fn(() => new Promise<Settings>((done) => { loadA = done })), vi.fn(() => new Promise<Settings>((done) => { saveA = done })))
  const b = api(vi.fn().mockResolvedValue({ timeoutMinutes: 45 }))
  window.pion = a
  const { rerender } = render(<QuestionSettings />)
  await act(async () => { await Promise.resolve() })
  await act(async () => loadA({ timeoutMinutes: 10 }))
  fireEvent.click(screen.getByRole('button', { name: '保存提问设置' }))
  window.pion = b
  rerender(<QuestionSettings />)
  await waitFor(() => expect(screen.getByRole('spinbutton')).toHaveValue(45))
  await act(async () => saveA({ timeoutMinutes: null }))
  expect(screen.getByRole('spinbutton')).toHaveValue(45)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('does not save defaults automatically after a corrupt or failed read', async () => {
  const set = vi.fn()
  window.pion = api(vi.fn().mockRejectedValue(new Error('corrupt file')), set)
  render(<QuestionSettings />)
  expect(await screen.findByRole('alert')).toHaveTextContent('未修改已保存设置')
  expect(set).not.toHaveBeenCalled()
})

it('retains a real pending read across unmount after its UI deadline and rejects its late value', async () => {
  vi.useFakeTimers()
  let finish!: (value: Settings) => void
  const get = vi.fn(() => new Promise<Settings>((done) => { finish = done }))
  window.pion = api(get)
  const first = render(<QuestionSettings />)
  await act(async () => { await Promise.resolve() })
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(screen.getByRole('alert')).toHaveTextContent('读取超时')
  first.unmount()
  render(<QuestionSettings />)
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(get).toHaveBeenCalledTimes(1)
  await act(async () => finish({ timeoutMinutes: null }))
  expect(screen.getByRole('spinbutton')).toHaveValue(10)
  expect(screen.getByRole('alert')).toHaveTextContent('读取超时')
})

it('retains a real pending save slot after its UI deadline', async () => {
  vi.useFakeTimers()
  let finish!: (value: Settings) => void
  const set = vi.fn(() => new Promise<Settings>((done) => { finish = done }))
  window.pion = api(undefined, set)
  const { container } = render(<QuestionSettings />)
  await act(async () => { await Promise.resolve() })
  fireEvent.submit(container.querySelector('form')!)
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(screen.getByRole('alert')).toHaveTextContent('结果尚未确认')
  fireEvent.submit(container.querySelector('form')!)
  expect(set).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('spinbutton')).toBeDisabled()
  await act(async () => finish({ timeoutMinutes: null }))
  expect(screen.getByRole('spinbutton')).toHaveValue(10)
  expect(screen.getByRole('spinbutton')).toBeEnabled()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
