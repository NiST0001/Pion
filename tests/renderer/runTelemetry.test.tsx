// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useRunTelemetry } from '../../src/renderer/src/hooks/useRunTelemetry'
import type { PionApi, RunOperation, RunTelemetryUpdate } from '../../src/shared/types'

afterEach(() => { delete (window as unknown as { pion?: unknown }).pion })

function metricRun(id: string, state: RunOperation['state'], createdAt: number): RunOperation {
  return { id, state, createdAt, cwd: '/a', sessionPath: '/a/session', revision: 1,
    usage: { input: 10, output: 20, total: 30, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.1 }
  } as RunOperation
}

it('keeps executing metrics through queue bursts and switches only when a queued run dispatches', async () => {
  let deliver!: (update: RunTelemetryUpdate) => void
  const running = metricRun('running', 'running', 1)
  const queued = Array.from({ length: 30 }, (_, n) => metricRun(`q-${n}`, 'queued', n))
  const get = vi.fn().mockResolvedValue([running, ...queued])
  window.pion = { getRunTelemetry: get, onRunTelemetry: (listener: typeof deliver) => { deliver = listener; return vi.fn() } } as unknown as PionApi
  const { result } = renderHook(() => useRunTelemetry({ hasBridge: true, cwd: '/a', sessionPath: '/a/session' }))
  await act(async () => { await Promise.resolve() })
  expect(get).toHaveBeenCalledWith(expect.objectContaining({ metricsOnly: true }))
  expect(result.current.activeRun?.id).toBe('running')
  expect(result.current.runs).toHaveLength(1)
  act(() => deliver({ runs: [...queued, { ...running, state: 'completed', revision: 2 }] }))
  expect(result.current.activeRun).toBeNull()
  expect(result.current.latestRun?.usage.total).toBe(30)
  act(() => deliver({ runs: [{ ...queued[0], state: 'dispatching', dispatchedAt: 200, revision: 2 }] }))
  expect(result.current.activeRun?.id).toBe('q-0')
  act(() => deliver({ runs: [{ ...queued[0], state: 'completed', dispatchedAt: 200, revision: 3 },
    metricRun('cancelled-queue', 'discarded', 500)] }))
  expect(result.current.latestRun?.id).toBe('q-0')
})

it('does not resurrect an older running snapshot after that record returned to the queue', async () => {
  let deliver!: (update: RunTelemetryUpdate) => void
  let resolve!: (runs: RunOperation[]) => void
  const response = new Promise<RunOperation[]>((done) => { resolve = done })
  window.pion = { getRunTelemetry: () => response,
    onRunTelemetry: (listener: typeof deliver) => { deliver = listener; return vi.fn() } } as unknown as PionApi
  const { result } = renderHook(() => useRunTelemetry({ hasBridge: true, cwd: '/a', sessionPath: '/a/session' }))
  act(() => deliver({ runs: [{ ...metricRun('requeued', 'queued', 1), revision: 2 }] }))
  await act(async () => { resolve([metricRun('requeued', 'running', 1)]); await response })
  expect(result.current.runs).toEqual([])
  expect(result.current.activeRun).toBeNull()
  expect(result.current.latestRun).toBeNull()
})

it('does not restore pre-compaction usage from a late telemetry snapshot', async () => {
  let deliver!: (update: RunTelemetryUpdate) => void
  let resolve!: (runs: RunOperation[]) => void
  const response = new Promise<RunOperation[]>((done) => { resolve = done })
  window.pion = {
    onRunTelemetry: (listener: typeof deliver) => { deliver = listener; return vi.fn() },
    getRunTelemetry: () => response
  } as unknown as PionApi
  const stale = { id: 'a', cwd: '/a', sessionPath: '/a/session', createdAt: 1, revision: 1,
    state: 'completed', contextPressure: 0.9 } as RunOperation
  const fresh = { ...stale, revision: 2, contextPressure: undefined, contextUsagePending: true }
  const { result } = renderHook(() => useRunTelemetry({ hasBridge: true, cwd: '/a', sessionPath: '/a/session' }))
  act(() => deliver({ runs: [fresh] }))
  await act(async () => { resolve([stale]); await response })
  expect(result.current.latestRun?.contextUsagePending).toBe(true)
  expect(result.current.latestRun?.contextPressure).toBeUndefined()
  act(() => deliver({ runs: [stale] }))
  expect(result.current.latestRun?.revision).toBe(2)
})
