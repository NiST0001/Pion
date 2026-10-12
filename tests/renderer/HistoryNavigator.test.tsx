// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
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
  it('retargets a single persistent accent between real visible entries without remounting buttons', () => {
    const props = { busy: false, onJump: vi.fn() }
    const { container, rerender } = render(<HistoryNavigator index={index} activeEntryId="one" {...props} />)
    const indicator = container.querySelector<HTMLElement>('.history-navigator-active-indicator')!
    const buttons = [...container.querySelectorAll('.history-navigator-marker')]
    expect(indicator).toHaveAttribute('aria-hidden', 'true')
    expect(indicator.style.transform).toBe('translateY(6px)')
    expect(indicator.style.transition).toBe('none')
    fireEvent.click(buttons[1], { detail: 0 })
    expect(props.onJump).toHaveBeenCalledExactlyOnceWith(index.landmarks[1])
    rerender(<HistoryNavigator index={index} activeEntryId="two" {...props} />)
    expect(container.querySelector('.history-navigator-active-indicator')).toBe(indicator)
    expect(indicator.style.transform).toBe('translateY(19px)')
    expect(indicator.style.transition).toBe('')
    expect(indicator).toHaveAttribute('data-entry-id', 'two')
    expect(buttons[1]).toHaveAttribute('aria-current', 'true')
    expect(buttons[0]).not.toHaveAttribute('aria-current')
    expect([...container.querySelectorAll('.history-navigator-marker')]).toEqual(buttons)
    // A second selection while the CSS transition is in flight retargets it.
    rerender(<HistoryNavigator index={index} activeEntryId="one" {...props} />)
    expect(indicator.style.transform).toBe('translateY(6px)')
    expect(indicator.style.transition).toBe('')
  })

  it('hides an unmatched accent and snaps first placement, real session changes and rail geometry changes', () => {
    const props = { busy: false, onJump: vi.fn() }
    const { container, rerender } = render(<HistoryNavigator index={index} activeEntryId="one" {...props} />)
    const indicator = container.querySelector<HTMLElement>('.history-navigator-active-indicator')!
    rerender(<HistoryNavigator index={index} activeEntryId="unknown" {...props} />)
    expect(indicator).toHaveAttribute('hidden')
    expect(indicator).not.toHaveAttribute('data-entry-id')
    rerender(<HistoryNavigator index={index} activeEntryId="two" {...props} />)
    expect(indicator).not.toHaveAttribute('hidden')
    expect(indicator.style.transition).toBe('none')
    rerender(<HistoryNavigator index={{ ...index, sessionPath: '/tmp/other.jsonl' }} activeEntryId="one" {...props} />)
    expect(container.querySelector('.history-navigator-active-indicator')).toBe(indicator)
    expect(indicator.style.transition).toBe('none')
    expect(indicator.style.transform).toBe('translateY(6px)')
    rerender(<HistoryNavigator index={index} activeEntryId="two" gap={15} maxVisible={3} {...props} />)
    expect(indicator.style.transition).toBe('none')
    expect(indicator.style.transform).toBe('translateY(24px)')
    // Reordering the same real IDs must not animate through obsolete slots.
    rerender(<HistoryNavigator index={{ ...index, landmarks: [...index.landmarks].reverse() }} activeEntryId="two" gap={15} maxVisible={3} {...props} />)
    expect(indicator.style.transition).toBe('none')
    expect(indicator.style.transform).toBe('translateY(6px)')
    expect(props.onJump).not.toHaveBeenCalled()
  })

  it('keeps the accent outside wheel-remounted strips and hides it when browsing away from the active entry', () => {
    const longIndex: SessionHistoryIndex = { ...index, landmarks: Array.from({ length: 8 }, (_, n) => ({
      ...index.landmarks[0], entryId: `wheel-${n}`, ordinal: n + 1, entryIndex: n * 2
    })) }
    const props = { busy: false, maxVisible: 4, activeEntryId: 'wheel-7', onJump: vi.fn() }
    const { container, rerender } = render(<HistoryNavigator index={longIndex} {...props} />)
    const indicator = container.querySelector<HTMLElement>('.history-navigator-active-indicator')!
    const strip = container.querySelector('.history-navigator-strip')!
    const track = container.querySelector('.history-navigator-track')!
    fireEvent.wheel(track, { deltaY: -36 })
    expect(container.querySelector('.history-navigator-active-indicator')).toBe(indicator)
    expect(container.querySelector('.history-navigator-strip')).not.toBe(strip)
    expect(indicator).toHaveAttribute('hidden')
    fireEvent.wheel(track, { deltaY: 36 })
    expect(indicator).not.toHaveAttribute('hidden')
    expect(indicator.style.transition).toBe('none')
    expect(container.querySelector('.history-navigator-active-carrier')).toHaveClass('wheel-scrolling')
    expect(container.querySelector<HTMLElement>('.history-navigator-active-carrier')!.style.getPropertyValue('--history-wheel-offset')).toBe('13px')
    // An out-of-window selection repositions the bounded window, not the old accent.
    rerender(<HistoryNavigator index={longIndex} {...props} activeEntryId="wheel-0" />)
    expect(indicator).toHaveAttribute('data-entry-id', 'wheel-0')
    expect(indicator.style.transition).toBe('none')
    expect(screen.getAllByRole('button')).toHaveLength(4)
    expect(props.onJump).not.toHaveBeenCalled()
  })

  it('snaps the accent after a resize changes the fitted rail window without issuing a jump', () => {
    let height = 100
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
    vi.stubGlobal('ResizeObserver', undefined)
    try {
      const longIndex: SessionHistoryIndex = { ...index, landmarks: Array.from({ length: 10 }, (_, n) => ({
        ...index.landmarks[0], entryId: `resize-${n}`, ordinal: n + 1, entryIndex: n * 2
      })) }
      const onJump = vi.fn()
      const { container } = render(<HistoryNavigator index={longIndex} activeEntryId="resize-8" busy={false} maxVisible={6} onJump={onJump} />)
      const indicator = container.querySelector<HTMLElement>('.history-navigator-active-indicator')!
      expect(screen.getAllByRole('button')).toHaveLength(6)
      expect(indicator.style.transform).toBe('translateY(58px)')
      height = 70
      fireEvent(window, new Event('resize'))
      expect(screen.getAllByRole('button')).toHaveLength(5)
      expect(container.querySelector('.history-navigator-active-indicator')).toBe(indicator)
      expect(indicator.style.transition).toBe('none')
      expect(indicator).toHaveAttribute('data-entry-id', 'resize-8')
      expect(onJump).not.toHaveBeenCalled()
    } finally {
      heightSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('matches the hover wave on the active overlay and preserves busy keyboard gating', () => {
    const props = { index, activeEntryId: 'one', onJump: vi.fn() }
    const { container, rerender } = render(<HistoryNavigator {...props} busy={false} />)
    const track = container.querySelector('.history-navigator-track')!
    fireEvent.pointerMove(track, { clientY: 0 })
    const bar = container.querySelector<HTMLElement>('.history-navigator-active-bar')!
    expect(bar.style.transform).toBe(container.querySelector<HTMLElement>('.history-navigator-marker.active')!.style.transform)
    expect(bar.style.transform).toBe('scaleX(4.200)')
    rerender(<HistoryNavigator {...props} busy />)
    const button = screen.getAllByRole('button')[0]
    expect(button).toBeDisabled()
    fireEvent.click(button, { detail: 0 })
    expect(props.onJump).not.toHaveBeenCalled()
  })

  it('uses a pointer-transparent themed sliding accent with reduced-motion and forced-color fallbacks', () => {
    const css = readFileSync('src/renderer/src/styles/history-navigator.css', 'utf8')
    expect(css).toMatch(/\.history-navigator-active-indicator\s*\{[^}]*pointer-events: none;[^}]*transition: transform 240ms/)
    expect(css).toMatch(/\.history-navigator-active-bar\s*\{[^}]*background: var\(--accent\)/)
    expect(css).not.toMatch(/\.history-navigator-marker\.active\s*\{/)
    const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedMotion).toMatch(/\.history-navigator-active-indicator,[\s\S]*transition: none/)
    expect(reducedMotion).toMatch(/\.history-navigator-active-carrier\.wheel-scrolling\s*\{\s*animation: none/)
    const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'), css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(forcedColors).toMatch(/\.history-navigator-active-bar\s*\{\s*background: Highlight/)
  })

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
