// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RunMetricsStrip } from '../../src/renderer/src/features/operations/RunMetricsStrip'
import type { RunOperation } from '../../src/shared/operations'

const run: RunOperation = {
  id: 'run-1',
  cwd: '/tmp/project',
  kind: 'prompt',
  state: 'completed',
  createdAt: 1_000,
  agentStartedAt: 2_000,
  settledAt: 33_000,
  provider: 'test',
  modelId: 'model-1',
  prompt: { message: 'hello', images: [] },
  promptPreview: 'hello',
  usage: {
    input: 10_000,
    output: 2_000,
    cacheRead: 500,
    cacheWrite: 0,
    reasoning: 300,
    total: 12_000,
    costUsd: 0.06
  },
  contextTokens: 12_000,
  contextWindow: 50_000,
  contextPressure: 0.24,
  tools: [],
  compactions: [],
  revision: 1
}

describe('RunMetricsStrip', () => {
  it('summarizes time, tokens, cost, and context in the floating trigger', () => {
    render(<RunMetricsStrip run={run} showCost />)
    const summary = screen.getByRole('button')
    expect(summary).toHaveTextContent('已完成')
    expect(summary).toHaveTextContent('31s')
    expect(summary).toHaveTextContent('12k tokens')
    expect(summary).toHaveTextContent('$0.060')
    expect(summary).toHaveTextContent('24%')
    expect(screen.getByTitle('上下文 12k / 50k')).toBeInTheDocument()
  })

  it('shows whole-session totals beside the current run when provided', () => {
    render(
      <RunMetricsStrip
        run={run}
        sessionTotals={{
          duration: 187_000,
          usage: { input: 40_000, output: 8_000, cacheRead: 1_000, cacheWrite: 0, reasoning: 1_000, total: 50_000, costUsd: 0.24 }
        }}
        showCost
      />
    )
    const summary = screen.getByRole('button')
    expect(summary).toHaveTextContent('会话')
    expect(summary).toHaveTextContent('3m 07s')
    expect(summary).toHaveTextContent('50k')
    expect(summary).toHaveTextContent('$0.240')
  })

  it('dismisses the floating details with Escape or an outside click and resets on run switch', () => {
    const { rerender } = render(<RunMetricsStrip run={run} />)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    const detail = screen.getByRole('region', { name: '统计详情' })
    expect(trigger).toHaveAttribute('aria-controls', detail.id)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: '统计详情' })).not.toBeInTheDocument()
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    rerender(<RunMetricsStrip run={{ ...run, revision: 2 }} />)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    rerender(<RunMetricsStrip run={{ ...run, id: 'other' }} />)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows pending context after compaction instead of the old percentage', () => {
    render(<RunMetricsStrip run={{ ...run, contextUsagePending: true }} />)
    expect(screen.getByRole('button')).not.toHaveTextContent('24%')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('上下文').nextElementSibling).toHaveTextContent('压缩后待更新')
  })

  it('reveals authoritative context and cost details on demand', () => {
    render(<RunMetricsStrip run={run} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('上下文').nextElementSibling).toHaveTextContent('12k / 50k')
    expect(screen.getByText('费用').nextElementSibling).toHaveTextContent('$0.060')
  })
})
