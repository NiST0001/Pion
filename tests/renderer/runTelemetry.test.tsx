// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useRunTelemetry } from '../../src/renderer/src/hooks/useRunTelemetry'
import type { PionApi, RunOperation, RunTelemetryUpdate } from '../../src/shared/types'

afterEach(() => { delete (window as unknown as { pion?: unknown }).pion })

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
