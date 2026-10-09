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
  it('uses the mounted turn identity, not the final whole-session index entry, including late indexing', () => {
    const onJump = vi.fn()
    const { container, rerender } = render(<HistoryNavigator index={null} activeEntryId="two" busy={false} onJump={onJump} />)
    const fullIndex: SessionHistoryIndex = {
      ...index,
      totalEntries: 8,
      landmarks: [...index.landmarks, { ...index.landmarks[1], entryId: 'unloaded-tail', ordinal: 3, entryIndex: 6 }]
    }
    rerender(<HistoryNavigator index={fullIndex} activeEntryId="two" busy={false} onJump={onJump} />)
    expect(container.querySelector('.history-navigator-marker.active')).toHaveAttribute('data-entry-id', 'two')
    rerender(<HistoryNavigator index={fullIndex} activeEntryId="unloaded-tail" busy={false} onJump={onJump} />)
    expect(container.querySelector('.history-navigator-marker.active')).toHaveAttribute('data-entry-id', 'unloaded-tail')
    expect(onJump).not.toHaveBeenCalled()
  })

  it('clears the preceding marker when the mounted current turn has no persisted locator', () => {
    const onJump = vi.fn()
    const { container, rerender } = render(<HistoryNavigator index={index} activeEntryId="one" busy={false} onJump={onJump} />)
    const markers = [...container.querySelectorAll('.history-navigator-marker')]
    expect(container.querySelector('.history-navigator-marker.active')).toBe(markers[0])
    rerender(<HistoryNavigator index={index} activeEntryId={undefined} busy={false} onJump={onJump} />)
    expect(container.querySelector('.history-navigator-marker.active')).not.toBeInTheDocument()
    expect([...container.querySelectorAll('.history-navigator-marker')]).toEqual(markers)
    // Backend-private display IDs must not be silently treated as SDK IDs or
    // resolve to the latest whole-session index landmark.
    rerender(<HistoryNavigator index={index} activeEntryId="fixture-backend:2" busy={false} onJump={onJump} />)
    expect(container.querySelector('.history-navigator-marker.active')).not.toBeInTheDocument()
    expect(onJump).not.toHaveBeenCalled()
  })

  it('keeps same-text, same-time landmarks distinct and jumps only to the explicitly selected SDK identity', () => {
    const duplicateIndex: SessionHistoryIndex = { ...index, landmarks: index.landmarks.map((landmark) => ({
      ...landmark, snippet: '相同的用户消息', timestamp: '2026-01-01T00:00:00.000Z'
    })) }
    const onJump = vi.fn()
    const { container, rerender } = render(<HistoryNavigator index={duplicateIndex} activeEntryId="conflicting-entry" busy={false} onJump={onJump} />)
    const markers = [...container.querySelectorAll('.history-navigator-marker')]
    expect(markers).toHaveLength(2)
    expect(container.querySelector('.history-navigator-marker.active')).not.toBeInTheDocument()
    expect(markers[0]).toHaveAttribute('data-entry-id', 'one')
    expect(markers[1]).toHaveAttribute('data-entry-id', 'two')
    fireEvent.click(markers[1], { detail: 0 })
    expect(onJump).toHaveBeenCalledExactlyOnceWith(duplicateIndex.landmarks[1])
    rerender(<HistoryNavigator index={duplicateIndex} activeEntryId="two" busy={false} onJump={onJump} />)
    expect(container.querySelector('.history-navigator-marker.active')).toBe(markers[1])
    expect(onJump).toHaveBeenCalledTimes(1)
  })

  it('adds live landmarks without snapping a manually browsed rail back to the active message', () => {
    const makeIndex = (count: number): SessionHistoryIndex => ({ ...index, totalEntries: count * 2,
      landmarks: Array.from({ length: count }, (_, n) => ({ ...index.landmarks[0], entryId: `live-${n + 1}`, entryIndex: n * 2, ordinal: n + 1, snippet: `live ${n + 1}` })) })
    const props = { busy: false, maxVisible: 4, activeEntryId: 'live-10', onJump: vi.fn() }
    const { container, rerender } = render(<HistoryNavigator index={makeIndex(10)} {...props} />)
    const track = container.querySelector('.history-navigator-track')!
    fireEvent.wheel(track, { deltaY: -72, deltaMode: 0 })
    expect(screen.getByLabelText(/第 5 条历史消息/)).toBeInTheDocument()
    rerender(<HistoryNavigator index={makeIndex(11)} {...props} />)
    expect(screen.getByLabelText(/第 5 条历史消息/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/第 10 条历史消息/)).not.toBeInTheDocument()
    expect(props.onJump).not.toHaveBeenCalled()
  })

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
