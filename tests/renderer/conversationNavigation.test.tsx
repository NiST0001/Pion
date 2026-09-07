// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import type { TimelineItem } from '../../src/renderer/src/agent/types'

vi.mock('../../src/renderer/src/utils/historyReveal', () => ({ armPendingHistoryRevealRows: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

describe('conversation navigation', () => {
  it('keeps a history jump in place through live updates, panel changes and settling', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const element = document.createElement('div')
    Object.defineProperties(element, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 400 }
    })
    const target = document.createElement('div')
    target.dataset.entryId = 'old-message'
    target.scrollIntoView = vi.fn(() => { element.scrollTop = 500 })
    element.append(target)
    const timeline: TimelineItem[] = []
    const options: Parameters<typeof useConversationNavigation>[0] = {
      scrollRef: { current: element }, timeline,
      timelineMutation: 'replace' as const, busy: true,
      historyJump: { entryId: 'old-message', nonce: 1 },
      panelsVisible: false,
      loadOlder: vi.fn(async () => undefined), loadNewer: vi.fn(async () => undefined)
    }
    const { rerender } = renderHook((props) => useConversationNavigation(props), { initialProps: options })
    act(() => { frames.splice(0).forEach((callback) => callback(0)) })
    expect(element.scrollTop).toBe(500)
    // No browser scroll event is dispatched: the jump must update follow state itself.
    rerender({ ...options, busy: false, panelsVisible: true })
    expect(element.scrollTop).toBe(500)
    Object.defineProperty(element, 'scrollHeight', { value: 2200 })
    rerender({ ...options, timeline: [...timeline], timelineMutation: 'append' })
    expect(element.scrollTop).toBe(500)
  })
})
