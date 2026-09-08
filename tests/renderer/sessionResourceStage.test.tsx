// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSessionResourceStage } from '../../src/renderer/src/hooks/useSessionResourceStage'
import { useRunTelemetry } from '../../src/renderer/src/hooks/useRunTelemetry'
import { RunMetricsStrip } from '../../src/renderer/src/features/operations/RunMetricsStrip'
import type { PionApi, RunOperation, RunTelemetryUpdate } from '../../src/shared/types'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { pion?: unknown }).pion
})

it('waits for first readiness, then keeps resource waves alive during same-session history loading', () => {
  const { result, rerender } = renderHook(({ key, ready }) => useSessionResourceStage(key, ready), {
    initialProps: { key: 'a', ready: false }
  })
  act(() => vi.advanceTimersByTime(1000))
  expect(result.current).toBe(0)
  rerender({ key: 'a', ready: true })
  act(() => vi.advanceTimersByTime(80))
  expect(result.current).toBe(2)
  rerender({ key: 'a', ready: false })
  expect(result.current).toBe(2)
  act(() => vi.advanceTimersByTime(500))
  expect(result.current).toBe(4)
  rerender({ key: 'a', ready: true })
  expect(result.current).toBe(4)
})

it('cancels old waves and resets only on a real session switch', () => {
  const { result, rerender } = renderHook(({ key, ready }) => useSessionResourceStage(key, ready), {
    initialProps: { key: 'a', ready: true }
  })
  act(() => vi.advanceTimersByTime(80))
  rerender({ key: 'b', ready: false })
  expect(result.current).toBe(0)
  act(() => vi.advanceTimersByTime(1000))
  expect(result.current).toBe(0)
  rerender({ key: 'b', ready: true })
  act(() => vi.advanceTimersByTime(500))
  expect(result.current).toBe(4)
})

it('keeps expanded statistics and the live subscription while navigating history', async () => {
  const run: RunOperation = {
    id: 'run-a', cwd: '/a', sessionPath: '/a/session', kind: 'prompt', state: 'running',
    createdAt: Date.now(), prompt: { message: 'test', images: [] }, promptPreview: 'test',
    usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 10, costUsd: 0 },
    tools: [], compactions: [], revision: 1
  }
  let deliver!: (update: RunTelemetryUpdate) => void
  const off = vi.fn()
  const subscribe = vi.fn((listener: typeof deliver) => { deliver = listener; return off })
  const get = vi.fn().mockResolvedValue([run])
  window.pion = { onRunTelemetry: subscribe, getRunTelemetry: get } as unknown as PionApi
  function Panel({ ready }: { ready: boolean }) {
    const stage = useSessionResourceStage('/a\0/a/session', ready)
    const telemetry = useRunTelemetry({ hasBridge: true, enabled: stage >= 1, cwd: '/a', sessionPath: '/a/session' })
    return <RunMetricsStrip run={telemetry.activeRun ?? telemetry.latestRun} />
  }
  const { rerender } = render(<Panel ready />)
  await act(async () => { vi.advanceTimersByTime(500) })
  const strip = screen.getByRole('region', { name: '运行指标' })
  fireEvent.click(screen.getByRole('button'))
  const detail = screen.getByRole('region', { name: '统计详情' })
  rerender(<Panel ready={false} />)
  expect(screen.getByRole('region', { name: '运行指标' })).toBe(strip)
  expect(screen.getByRole('region', { name: '统计详情' })).toBe(detail)
  act(() => deliver({ runs: [{ ...run, revision: 2, usage: { ...run.usage, input: 77, total: 77 } }] }))
  expect(screen.getByRole('button')).toHaveTextContent('77 tokens')
  rerender(<Panel ready />)
  act(() => vi.advanceTimersByTime(500))
  expect(screen.getByRole('region', { name: '统计详情' })).toBe(detail)
  expect(screen.getByRole('button')).toHaveTextContent('77 tokens')
  expect(get).toHaveBeenCalledTimes(1)
  expect(subscribe).toHaveBeenCalledTimes(1)
  expect(off).not.toHaveBeenCalled()
})
