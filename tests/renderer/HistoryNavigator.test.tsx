// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HistoryNavigator } from '../../src/renderer/src/features/session/HistoryNavigator'
import type { SessionHistoryIndex } from '../../src/shared/types'

const index: SessionHistoryIndex = {
  sessionPath: '/tmp/session.jsonl',
  totalEntries: 4,
  landmarks: [
    { entryId: 'one', entryIndex: 0, ordinal: 1, snippet: 'first', timestamp: '2026-01-01T00:00:00Z' },
    { entryId: 'two', entryIndex: 2, ordinal: 2, snippet: 'second', timestamp: '2026-01-01T00:01:00Z' }
  ]
}

describe('HistoryNavigator', () => {
  it('renders history geometry and applies the hover decay curve without task-panel compensation', () => {
    const { container } = render(
      <HistoryNavigator
        index={index}
        busy={false}
        onJump={vi.fn()}
      />
    )
    const navigator = screen.getByLabelText('会话历史快速导航')
    expect(navigator).not.toHaveAttribute('style')
    expect(screen.getAllByRole('button')).toHaveLength(2)

    const track = container.querySelector('.history-navigator-track') as HTMLElement
    fireEvent.pointerMove(track, { clientY: 0 })
    const markerScales = [...container.querySelectorAll<HTMLElement>('.history-navigator-marker')]
      .map((marker) => Number(marker.style.transform.match(/scaleX\(([\d.]+)\)/)?.[1] ?? 0))
    expect(markerScales[0]).toBeGreaterThan(4)
    expect(markerScales[1]).toBeGreaterThan(2)
    expect(markerScales[1]).toBeLessThan(markerScales[0])
    expect(container.querySelector('.history-navigator-preview')).toBeInTheDocument()
  })

  it('limits mounted bars and scrolls the history window with the mouse wheel', () => {
    const longIndex: SessionHistoryIndex = {
      sessionPath: '/tmp/long-session.jsonl',
      totalEntries: 24,
      landmarks: Array.from({ length: 12 }, (_, itemIndex) => ({
        entryId: `entry-${itemIndex + 1}`,
        entryIndex: itemIndex * 2,
        ordinal: itemIndex + 1,
        snippet: `message ${itemIndex + 1}`,
        timestamp: `2026-01-01T00:${String(itemIndex).padStart(2, '0')}:00Z`
      }))
    }
    const { container } = render(
      <HistoryNavigator
        index={longIndex}
        busy={false}
        maxVisible={4}
        onJump={vi.fn()}
      />
    )

    expect(screen.getAllByRole('button')).toHaveLength(4)
    expect(screen.getByLabelText(/第 9 条历史消息/)).toBeInTheDocument()
    expect(screen.getByLabelText(/第 12 条历史消息/)).toBeInTheDocument()
    expect(container.querySelectorAll('.history-navigator-marker-slot')).toHaveLength(4)
    expect(container.querySelectorAll('[data-group-divider="true"]')).toHaveLength(1)

    expect([...container.querySelectorAll<HTMLElement>('.history-navigator-marker')]
      .every((marker) => marker.style.width === '')).toBe(true)

    const track = container.querySelector('.history-navigator-track') as HTMLElement
    fireEvent.wheel(track, { deltaY: -36, deltaMode: 0 })

    expect(screen.getByLabelText(/第 8 条历史消息/)).toBeInTheDocument()
    expect(screen.getByLabelText(/第 11 条历史消息/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/第 12 条历史消息/)).not.toBeInTheDocument()
    const scrollingStrip = container.querySelector('.history-navigator-strip') as HTMLElement
    expect(scrollingStrip).toHaveClass('wheel-scrolling')
    expect(scrollingStrip.style.getPropertyValue('--history-wheel-offset')).toBe('-13px')
    expect(scrollingStrip.style.cssText).not.toContain('spike')
  })
})
