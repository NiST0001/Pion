// @vitest-environment jsdom
import { act, render, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import type { TimelineItem } from '../../src/renderer/src/agent/types'
import type { SessionHistoryIndex } from '../../src/shared/types'
import { ChatMessage } from '../../src/renderer/src/features/chat/ChatMessage'
import { HistoryNavigator } from '../../src/renderer/src/features/session/HistoryNavigator'

vi.mock('../../src/renderer/src/utils/historyReveal', () => ({ armPendingHistoryRevealRows: vi.fn(), armHistoryRevealRow: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

function settleFrames(frames: FrameRequestCallback[]) {
  for (let time = 0; frames.length && time <= 1000; time += 20) {
    act(() => frames.splice(0).forEach((callback) => callback(time)))
  }
}

function markerFixture() {
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++frameId, callback); return frameId })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
  let time = 0
  const flush = () => act(() => {
    const pending = [...frames.values()]
    frames.clear()
    time += 20
    pending.forEach((callback) => callback(time))
  })
  const finish = () => { for (let index = 0; frames.size && index < 50; index++) flush() }
  let resize = (_entries?: ResizeObserverEntry[]) => {}
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: (entries?: ResizeObserverEntry[]) => void) { resize = callback }
    observe() {}
    disconnect() {}
  })
  const element = document.createElement('div')
  document.body.append(element)
  let scrollTop = 0
  Object.defineProperties(element, {
    scrollHeight: { value: 3000 },
    clientHeight: { value: 400, configurable: true },
    // jsdom has no layout engine: model the browser's scroll-range clamping
    // without suppressing or hiding writes from the existing follow behavior.
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, value)) }
    }
  })
  const content = document.createElement('div')
  content.className = 'timeline'
  element.append(content)
  const positions = [400, 800]
  let contentWidth = 600
  Object.defineProperties(content, {
    offsetHeight: { configurable: true, get: () => positions[1] + 100 },
    offsetWidth: { get: () => contentWidth }
  })
  const rows = positions.map((_, index) => {
    const row = document.createElement('div')
    row.className = 'row-user'
    row.dataset.entryId = `entry-${index}`
    row.getBoundingClientRect = () => ({ top: positions[index] - element.scrollTop } as DOMRect)
    content.append(row)
    return row
  })
  const options: Parameters<typeof useConversationNavigation>[0] = {
    scrollRef: { current: element }, timeline: [{ kind: 'user', id: 1, text: 'first' }],
    timelineMutation: 'replace', busy: false, sessionPath: '/a', historyJump: null,
    loadOlder: vi.fn(async () => {}), loadNewer: vi.fn(async () => {})
  }
  const hook = renderHook((props) => useConversationNavigation(props), { initialProps: options })
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
  element.scrollTop = 500
  act(() => hook.result.current.handleTimelineScroll())
  flush()
  return { ...hook, options, element, rows, positions, frames, flush, finish,
    width: (value: number) => { contentWidth = value },
    resize: (entries?: ResizeObserverEntry[]) => act(() => resize(entries))
  }
}

describe('conversation navigation', () => {
  it('animates a mounted jump frame by frame, remeasures layout and does not page or pin during motion', () => {
    const f = markerFixture()
    const jumped = { ...f.options, historyJump: { entryId: 'entry-1', nonce: 1 } }
    f.rerender(jumped)
    f.flush() // locate actual row; no immediate scroll
    expect(f.element.scrollTop).toBe(500)
    f.flush() // curve origin
    f.flush()
    expect(f.element.scrollTop).toBeGreaterThan(500)
    expect(f.element.scrollTop).toBeLessThan(648)
    f.positions[1] = 1200
    f.element.style.paddingTop = '50px'
    f.element.style.setProperty('--conversation-top-clearance', '50px')
    const beforeResize = f.element.scrollTop
    f.resize()
    f.rerender({ ...jumped, timeline: [...jumped.timeline], timelineMutation: 'prepend', panelsVisible: true })
    expect(f.element.scrollTop).toBe(beforeResize)
    f.finish()
    expect(f.element.scrollTop).toBeCloseTo(1200 - (50 + 350 * 0.38))
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-1')
    act(() => f.result.current.handleTimelineScroll())
    expect(f.options.loadOlder).not.toHaveBeenCalled()
    expect(f.options.loadNewer).not.toHaveBeenCalled()
  })

  it('continues a new jump from the current offset and does not animate an already aligned target again', () => {
    const f = markerFixture()
    f.rerender({ ...f.options, historyJump: { entryId: 'entry-1', nonce: 1 } })
    f.flush()
    f.flush()
    f.flush()
    const interrupted = f.element.scrollTop
    const late = [...f.frames.values()]
    f.rerender({ ...f.options, historyJump: { entryId: 'entry-0', nonce: 2 } })
    act(() => late.forEach((callback) => callback(1000)))
    expect(f.element.scrollTop).toBe(interrupted)
    f.flush()
    expect(f.element.scrollTop).toBe(interrupted)
    f.finish()
    expect(f.element.scrollTop).toBe(248)
    f.rerender({ ...f.options, historyJump: { entryId: 'entry-0', nonce: 3 } })
    f.flush()
    expect(f.element.scrollTop).toBe(248)
    expect(f.frames.size).toBe(0)
  })

  it.each(['wheel', 'touch', 'pointer', 'PageUp'] as const)('cancels jump motion on %s and rejects a captured late frame', (gesture) => {
    const f = markerFixture()
    f.rerender({ ...f.options, historyJump: { entryId: 'entry-1', nonce: 1 } })
    f.flush()
    f.flush()
    f.flush()
    const late = [...f.frames.values()]
    const stopped = f.element.scrollTop
    act(() => {
      if (gesture === 'wheel') f.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }))
      else if (gesture === 'touch') f.element.dispatchEvent(new Event('touchstart'))
      else if (gesture === 'pointer') f.element.dispatchEvent(new Event('pointerdown'))
      else f.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }))
      late.forEach((callback) => callback(1000))
    })
    f.finish()
    expect(f.element.scrollTop).toBe(stopped)
  })

  it.each(['scope', 'reset', 'hidden', 'removed target', 'unmount'] as const)('fences late jump frames after %s', (change) => {
    const f = markerFixture()
    const jumped = { ...f.options, historyJump: { entryId: 'entry-1', nonce: 1 } }
    f.rerender(jumped)
    f.flush()
    f.flush()
    const late = [...f.frames.values()]
    if (change === 'scope') f.rerender({ ...jumped, projectCwd: '/new-project' })
    else if (change === 'reset') f.rerender({ ...jumped, historyResetRevision: 1 })
    else if (change === 'hidden') f.rerender({ ...jumped, viewportActive: false })
    else if (change === 'removed target') f.rows[1].remove()
    else f.unmount()
    const stopped = f.element.scrollTop
    act(() => late.forEach((callback) => callback(1000)))
    expect(f.element.scrollTop).toBe(stopped)
  })

  it('waits for a target page DOM before moving and honors reduced motion', async () => {
    const f = markerFixture()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true } as MediaQueryList)))
    f.rows[1].remove()
    const jumped = { ...f.options, timelineLoading: true, historyJump: { entryId: 'entry-1', nonce: 1 } }
    f.rerender(jumped)
    f.flush()
    expect(f.element.scrollTop).toBe(500)
    await act(async () => { f.rows[0].parentElement!.append(f.rows[1]); await Promise.resolve() })
    f.flush()
    expect(f.element.scrollTop).toBe(648)
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-1')
  })

  it.each(['wheel', 'touch', 'PageUp'] as const)('binds a conditionally mounted viewport and pauses on %s before any scroll event', (gesture) => {
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++frameId, callback); return frameId })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
    const observers: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn()
      disconnect = vi.fn()
      constructor(callback: () => void) { observers.push({ callback, observe: this.observe, disconnect: this.disconnect }) }
    })
    const addWindow = vi.spyOn(window, 'addEventListener')
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    const loadOlder = vi.fn(async () => {})
    const loadNewer = vi.fn(async () => {})
    let height = 3000
    let writes = 0
    const timeline: TimelineItem[] = [{ kind: 'user', id: 1, text: 'child prompt' }]
    function Viewport({ active, items }: { active: boolean; items: TimelineItem[] }) {
      const scrollRef = useRef<HTMLDivElement | null>(null)
      const navigation = useConversationNavigation({
        scrollRef, viewportActive: active, timeline: items, timelineMutation: 'append', busy: true,
        historyJump: null, sessionPath: '/child', loadOlder, loadNewer
      })
      return active ? <div data-testid="viewport" ref={(element) => {
        scrollRef.current = element
        if (!element || Object.hasOwn(element, 'scrollHeight')) return
        let top = 0
        Object.defineProperties(element, {
          scrollHeight: { get: () => height }, clientHeight: { value: 400 },
          scrollTop: { get: () => top, set: (value: number) => { writes++; top = Math.max(0, Math.min(height - 400, value)) } }
        })
      }} onScroll={navigation.handleTimelineScroll}>
        <div ref={(surface) => {
          navigation.scrollSurfaceRef.current = surface
          if (surface) surface.getBoundingClientRect = () => ({ height } as DOMRect)
        }}><div className="timeline" ref={(content) => {
          if (content) Object.defineProperty(content, 'offsetHeight', { configurable: true, get: () => height })
        }} /></div>
      </div> : null
    }
    const view = render(<Viewport active={false} items={timeline} />)
    expect(observers).toHaveLength(0)
    expect(addWindow.mock.calls.filter(([name]) => name === 'resize')).toHaveLength(0)
    view.rerender(<Viewport active items={timeline} />)
    let element = view.getByTestId('viewport')
    expect(element.scrollTop).toBe(2600)
    expect(observers.some((observer) => observer.observe.mock.calls.some(([target]) => target === element))).toBe(true)
    const pause = () => act(() => {
      if (gesture === 'wheel') element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
      else if (gesture === 'PageUp') element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
      else {
        const touch = new Event('touchstart', { bubbles: true })
        Object.defineProperty(touch, 'touches', { value: [{ clientY: 200 }] })
        element.dispatchEvent(touch)
      }
    })
    pause()
    // The input itself pauses following; no scroll event (or offset change)
    // is needed before the next streaming append/resize delivery.
    const stoppedWrites = writes
    height = 3400
    const appended: TimelineItem[] = [...timeline, { kind: 'assistant', id: 2, text: 'streaming', thinking: '', streaming: true }]
    view.rerender(<Viewport active items={appended} />)
    act(() => observers.at(-1)!.callback())
    expect(writes).toBe(stoppedWrites)
    expect(element.scrollTop).toBe(2600)
    // Explicit bottom navigation, unlike layout, resumes the existing intent.
    act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(element.scrollTop).toBe(3000)
    height = 3600
    view.rerender(<Viewport active items={[...appended, { kind: 'user', id: 3, text: 'more' }]} />)
    expect(element.scrollTop).toBe(3200)
    pause()
    const removeElement = vi.spyOn(element, 'removeEventListener')
    const activeObservers = observers.filter((observer) => observer.disconnect.mock.calls.length === 0)
    view.rerender(<Viewport active={false} items={appended} />)
    expect(view.queryByTestId('viewport')).toBeNull()
    for (const name of ['wheel', 'touchstart', 'touchmove', 'pointermove', 'pointerdown', 'keydown']) {
      expect(removeElement.mock.calls.some(([type]) => type === name)).toBe(true)
    }
    expect(activeObservers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true)
    expect(removeWindow.mock.calls.some(([name]) => name === 'resize')).toBe(true)
    expect(frames.size).toBe(0)
    const closedWrites = writes
    view.rerender(<Viewport active items={appended} />)
    element = view.getByTestId('viewport')
    // Reactivating isn't a new session or a request to follow the latest turn.
    expect(writes).toBe(closedWrites)
    expect(element.scrollTop).toBe(0)
    act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(element.scrollTop).toBe(3200)
    pause()
    const reopenedWrites = writes
    height = 3800
    view.rerender(<Viewport active items={[...appended, { kind: 'user', id: 4, text: 'last' }]} />)
    expect(writes).toBe(reopenedWrites)
    expect(loadOlder).not.toHaveBeenCalled()
    expect(loadNewer).not.toHaveBeenCalled()
    view.unmount()
    expect(frames.size).toBe(0)
  })

  it('tracks the real mounted live turn without an entry ID, including a late same-session index and running response', () => {
    const f = markerFixture()
    const content = f.element.querySelector<HTMLElement>('.timeline')!
    content.replaceChildren()
    const surface = document.createElement('div')
    f.element.replaceChildren(surface)
    surface.append(content)
    f.result.current.scrollSurfaceRef.current = surface
    Object.defineProperty(content, 'offsetHeight', { get: () => 3000 })
    surface.getBoundingClientRect = () => ({ height: 3000 } as DOMRect)
    const previous: Extract<TimelineItem, { kind: 'user' }> = {
      kind: 'user', id: 100, entryId: 'previous', text: 'same text', messageTimestamp: 4000
    }
    const latest: Extract<TimelineItem, { kind: 'user' }> = {
      kind: 'user', id: 101, liveMessageId: 'backend:2', text: 'same text', messageTimestamp: 5000
    }
    const answer: Extract<TimelineItem, { kind: 'assistant' }> = {
      kind: 'assistant', id: 102, text: '', thinking: 'working', streaming: true
    }
    render(<><ChatMessage item={previous} canFork={false} />
      <ChatMessage item={latest} canFork={false} />
      <ChatMessage item={answer} canFork={false} /></>, { container: content })
    const rows = [...content.querySelectorAll<HTMLElement>('.row-user')]
    rows[0].getBoundingClientRect = () => ({ top: 2700 - f.element.scrollTop } as DOMRect)
    rows[1].getBoundingClientRect = () => ({ top: 2950 - f.element.scrollTop } as DOMRect)
    expect(rows[1].dataset.entryId).toBeUndefined()
    const timeline: TimelineItem[] = [previous, latest, answer,
      { kind: 'tool', id: 103, tool: { id: 'working', name: 'read', status: 'running', isError: false } }]
    f.element.scrollTop = 2600
    const scrollWrite = vi.spyOn(f.element, 'scrollTop', 'set')
    const oldIndex: SessionHistoryIndex = { sessionPath: '/a', totalEntries: 4, landmarks: [
      { entryId: 'previous', entryIndex: 0, ordinal: 1, snippet: 'same text', timestamp: 'append clock', messageTimestamp: 4000 }
    ] }
    f.rerender({ ...f.options, busy: true, timeline, historyIndex: oldIndex })
    f.flush()
    // A latest mounted row without a persisted locator must not mark N-1.
    expect(f.result.current.visibleHistoryEntryId).toBeUndefined()
    const index: SessionHistoryIndex = { ...oldIndex, totalEntries: 8, landmarks: [
      ...oldIndex.landmarks,
      { entryId: 'latest', entryIndex: 4, ordinal: 2, snippet: 'same text', timestamp: 'different append clock', messageTimestamp: 5000 },
      { entryId: 'unmounted', entryIndex: 7, ordinal: 3, snippet: 'later unseen', timestamp: '', messageTimestamp: 6000 }
    ] }
    // Only the index changes, not its session path or the mounted messages.
    f.rerender({ ...f.options, busy: true, timeline, historyIndex: index })
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('latest')
    const bar = render(<HistoryNavigator index={index} activeEntryId={f.result.current.visibleHistoryEntryId}
      busy onJump={vi.fn()} />)
    expect(bar.container.querySelector<HTMLElement>('.history-navigator-marker.active')?.dataset.entryId).toBe('latest')
    f.rerender({ ...f.options, busy: true, timeline: [previous, latest, { ...answer, thinking: 'working longer' }, timeline[3]], historyIndex: index })
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('latest')
    expect(rows[1].dataset.entryId).toBeUndefined() // navigation does not invent undo/fork identity
    expect(scrollWrite).not.toHaveBeenCalled()
    expect(f.options.loadOlder).not.toHaveBeenCalled()
    expect(f.options.loadNewer).not.toHaveBeenCalled()
  })

  it.each(['missing clock', 'duplicate index clock', 'duplicate row clock', 'claimed entry', 'wrong session', 'append clock only'] as const)(
    'does not guess the latest mounted user marker from %s', (reason) => {
      const f = markerFixture()
      const latest = f.rows[1]
      delete latest.dataset.entryId
      if (reason !== 'missing clock') latest.dataset.userMessageTime = '5000'
      if (reason === 'duplicate row clock') f.rows[0].dataset.userMessageTime = '5000'
      if (reason === 'claimed entry') f.rows[0].dataset.entryId = 'latest'
      const index: SessionHistoryIndex = { sessionPath: reason === 'wrong session' ? '/other' : '/a', totalEntries: 3, landmarks: [
        { entryId: 'latest', entryIndex: 1, ordinal: 1, snippet: 'text', timestamp: '5000',
          ...(reason === 'append clock only' ? {} : { messageTimestamp: 5000 }) },
        ...(reason === 'duplicate index clock' ? [{ entryId: 'conflict', entryIndex: 2, ordinal: 2, snippet: 'text', timestamp: '', messageTimestamp: 5000 }] : [])
      ] }
      f.element.scrollTop = 2600
      f.rerender({ ...f.options, historyIndex: index })
      f.flush()
      expect(f.result.current.visibleHistoryEntryId).toBeUndefined()
    }
  )

  it('marks the last mounted short turn at the session end without moving or resuming follow', () => {
    const f = markerFixture()
    f.positions[0] = 2750
    f.positions[1] = 2770
    const last = document.createElement('div')
    last.className = 'row-user'
    last.dataset.entryId = 'entry-2'
    last.getBoundingClientRect = () => ({ top: 2790 - f.element.scrollTop } as DOMRect)
    f.rows[1].parentElement!.append(last)
    f.element.style.setProperty('--conversation-bottom-clearance', '140px')
    const timeline: TimelineItem[] = [
      { kind: 'user', id: 1, entryId: 'entry-0', text: 'first' },
      { kind: 'assistant', id: 2, text: 'long answer', thinking: '', streaming: false },
      { kind: 'tool', id: 3, tool: { id: 'tool', name: 'read', status: 'done', isError: false, outputText: 'long output' } },
      { kind: 'user', id: 4, entryId: 'entry-1', text: 'next' },
      { kind: 'user', id: 5, entryId: 'entry-2', text: 'latest' }
    ]
    // Refresh geometry without a scroll handler: the fixture's earlier wheel
    // gesture is still live, so forward scrolling would legitimately follow.
    f.element.scrollTop = 2600
    const scrollWrite = vi.spyOn(f.element, 'scrollTop', 'set')
    f.rerender({ ...f.options, timeline, panelsVisible: true })
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-2')
    expect(f.element.scrollTop).toBe(2600)
    f.resize()
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-2')
    f.rerender({ ...f.options, timeline: [...timeline], historyIndexSessionPath: '/a' })
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-2')
    expect(f.element.scrollTop).toBe(2600) // read-only refresh did not restore follow
    expect(scrollWrite).not.toHaveBeenCalled()
    expect(f.options.loadOlder).not.toHaveBeenCalled()
    expect(f.options.loadNewer).not.toHaveBeenCalled()
  })

  it.each([0, 1, 2, 80])('uses only one pixel of bottom rounding, not the prefetch zone (%s px)', (distance) => {
    const f = markerFixture()
    f.positions[0] = 2400
    f.positions[1] = 2900
    f.element.scrollTop = 2600 - distance
    const scrollWrite = vi.spyOn(f.element, 'scrollTop', 'set')
    f.resize()
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe(distance <= 1 ? 'entry-1' : 'entry-0')
    expect(f.element.scrollTop).toBe(2600 - distance)
    expect(scrollWrite).not.toHaveBeenCalled()
    expect(f.options.loadOlder).not.toHaveBeenCalled()
    expect(f.options.loadNewer).not.toHaveBeenCalled()
  })

  it.each(['newer page', 'loading', 'blank tail'] as const)('does not mistake %s for the session end', (state) => {
    const f = markerFixture()
    f.positions[0] = 2400
    f.positions[1] = 2900
    if (state === 'blank tail') {
      const surface = document.createElement('div')
      f.element.prepend(surface)
      surface.append(f.rows[0].parentElement!)
      surface.getBoundingClientRect = () => ({ height: 3000 } as DOMRect)
      Object.defineProperty(f.rows[0].parentElement!, 'offsetHeight', { value: 2200 })
      f.result.current.scrollSurfaceRef.current = surface
      f.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }))
    }
    f.element.scrollTop = 2600
    f.rerender({ ...f.options, timelineLoading: state === 'loading', hasNewerHistory: () => state === 'newer page' })
    act(() => f.result.current.handleTimelineScroll())
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-0')
    expect(f.element.scrollTop).toBe(2600)
    expect(f.options.loadNewer).not.toHaveBeenCalled()
  })

  it('refreshes the mounted tail after same-length replacement and completed loading', () => {
    const f = markerFixture()
    f.positions[0] = 2400
    f.positions[1] = 2900
    f.element.scrollTop = 2600
    f.rerender({ ...f.options, timelineLoading: true })
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-0')
    f.rows[1].dataset.entryId = 'replacement-tail'
    f.rerender({ ...f.options, timeline: [{ kind: 'user', id: 8, text: 'replacement tail' }], historyIndexSessionPath: '/a' })
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('replacement-tail')
    expect(f.element.scrollTop).toBe(2600)
  })

  it('keeps a bottom-clamped explicit earlier turn until outward input releases it even without scroll', () => {
    const f = markerFixture()
    f.positions[0] = 2900
    f.positions[1] = 2920
    f.rerender({ ...f.options, historyJump: { entryId: 'entry-0', nonce: 1 } })
    f.flush()
    expect(f.element.scrollTop).toBe(500)
    f.finish()
    expect(f.element.scrollTop).toBe(2600)
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-0')
    act(() => f.result.current.handleTimelineScroll())
    f.resize()
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-0')
    f.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 20 }))
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-1')
  })

  it('recomputes a same-length replacement without scrolling or paging', () => {
    const f = markerFixture()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-0')
    f.rows[0].dataset.entryId = 'replacement'
    f.rerender({ ...f.options, timeline: [{ kind: 'user', id: 2, text: 'replacement' }] })
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('replacement')
    expect(f.element.scrollTop).toBe(500)
    expect(f.options.loadOlder).not.toHaveBeenCalled()
    expect(f.options.loadNewer).not.toHaveBeenCalled()
  })

  it.each(['content', 'viewport', 'clearance'] as const)('updates the active marker after %s layout without a scroll event', (change) => {
    const f = markerFixture()
    if (change === 'content') f.positions[1] = 640
    if (change === 'viewport') {
      f.positions[1] = 740
      Object.defineProperty(f.element, 'clientHeight', { value: 1000 })
    }
    if (change === 'clearance') f.element.style.setProperty('--conversation-top-clearance', '300px')
    f.resize()
    f.resize()
    expect(f.frames.size).toBe(1)
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-1')
    expect(f.element.scrollTop).toBe(500)
    f.rerender({ ...f.options, timeline: [...f.options.timeline] })
    expect(f.element.scrollTop).toBe(500) // marker refresh did not restore follow intent
    expect(f.options.loadOlder).not.toHaveBeenCalled()
    expect(f.options.loadNewer).not.toHaveBeenCalled()
  })

  it('refreshes width/fractional layout versions at the same rounded height, but ignores repeated boxes', () => {
    const f = markerFixture()
    const content = f.element.querySelector<HTMLElement>('.timeline')!
    Object.defineProperty(content, 'offsetHeight', { value: 900 })
    const box = (width: number): ResizeObserverEntry[] => [{ target: content,
      contentRect: new DOMRect(0, 0, width, 900), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }]
    f.resize(box(600)) // first delivery also reconciles the initial layout
    expect(f.frames.size).toBe(1)
    f.flush()
    f.positions[1] = 640
    f.width(599)
    f.resize(box(599.5))
    expect(f.frames.size).toBe(1)
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-1')
    f.positions[1] = 800
    f.resize(box(599.25)) // offsetWidth/offsetHeight are unchanged
    expect(f.frames.size).toBe(1)
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-0')
    f.resize(box(599.25))
    expect(f.frames.size).toBe(0)
    expect(f.element.scrollTop).toBe(500)
    expect(f.options.loadOlder).not.toHaveBeenCalled()
    expect(f.options.loadNewer).not.toHaveBeenCalled()
  })

  it('recomputes when the history index arrives late rather than clearing the marker', () => {
    const f = markerFixture()
    f.positions[1] = 640
    f.rerender({ ...f.options, historyIndexSessionPath: '/a' })
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-1')
    expect(f.element.scrollTop).toBe(500)
  })

  it('does not choose a closer future user while the current long turn spans the reference point', () => {
    const f = markerFixture()
    // Reference = 652; future row 800 is closer than current row 400.
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-0')
    f.positions[1] = 652
    f.resize()
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-1')
  })

  it('keeps an explicit selection through replacement, late index and layout until actual user scrolling', () => {
    const f = markerFixture()
    const jumped = { ...f.options, historyJump: { entryId: 'entry-1', nonce: 1 } }
    f.rerender(jumped)
    f.finish()
    const position = f.element.scrollTop
    f.positions[1] = 2000
    f.rerender({ ...jumped, timeline: [...jumped.timeline], historyIndexSessionPath: '/a' })
    f.resize()
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-1')
    expect(f.element.scrollTop).toBe(position)
    f.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }))
    f.resize()
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-1') // input alone has not moved the viewport
    f.element.scrollTop -= 20
    act(() => f.result.current.handleTimelineScroll())
    f.flush()
    expect(f.result.current.visibleHistoryEntryId).toBe('entry-0')
  })
  it('compensates floating summary clearance without leaving manual reading', () => {
    let resize = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect() {}
    })
    const element = document.createElement('div')
    element.style.paddingTop = '38px'
    // Attach the fixture so jsdom invalidates computed styles on padding changes,
    // as it does for the real mounted scroll viewport.
    document.body.append(element)
    Object.defineProperties(element, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } })
    const { result } = renderHook(() => useConversationNavigation({
      scrollRef: { current: element }, timeline: [], timelineMutation: 'replace', busy: false,
      historyJump: null, loadOlder: vi.fn(async () => {}), loadNewer: vi.fn(async () => {})
    }))
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
    element.scrollTop = 500
    act(() => result.current.handleTimelineScroll())
    element.style.paddingTop = '76px'
    act(() => resize())
    expect(element.scrollTop).toBe(538)
    act(() => { result.current.handleTimelineScroll(); resize() })
    expect(element.scrollTop).toBe(538)
    element.style.paddingTop = '38px'
    act(() => resize())
    expect(element.scrollTop).toBe(500)
  })

  it('locates history inside the unobscured area between both floating rows', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const element = document.createElement('div')
    element.style.setProperty('--conversation-top-clearance', '50px')
    element.style.setProperty('--conversation-bottom-clearance', '120px')
    Object.defineProperties(element, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } })
    const target = document.createElement('div')
    target.dataset.entryId = 'target'
    document.body.append(element)
    target.getBoundingClientRect = () => ({ top: 600 - element.scrollTop } as DOMRect)
    element.append(target)
    renderHook(() => useConversationNavigation({
      scrollRef: { current: element }, timeline: [{ kind: 'user', id: 1, text: 'target' }],
      timelineMutation: 'replace', busy: false, historyJump: { entryId: 'target', nonce: 1 },
      loadOlder: vi.fn(async () => {}), loadNewer: vi.fn(async () => {})
    }))
    settleFrames(frames)
    expect(element.scrollTop).toBeCloseTo(600 - (50 + (400 - 50 - 120) * 0.38))
  })

  it('preserves manual reading on replacement and resizing but follows a genuinely new session', () => {
    let resize = () => undefined as void
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect() {}
    })
    const element = document.createElement('div')
    Object.defineProperties(element, { scrollHeight: { value: 2000 }, clientHeight: { value: 400, configurable: true } })
    const options: Parameters<typeof useConversationNavigation>[0] = {
      scrollRef: { current: element }, timeline: [], timelineMutation: 'replace', busy: false,
      sessionPath: '/a', historyJump: null,
      loadOlder: vi.fn(async () => undefined), loadNewer: vi.fn(async () => undefined)
    }
    const { result, rerender } = renderHook((props) => useConversationNavigation(props), { initialProps: options })
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
    element.scrollTop = 500
    act(() => result.current.handleTimelineScroll())
    rerender({ ...options, timeline: [] })
    expect(element.scrollTop).toBe(500)
    Object.defineProperty(element, 'clientHeight', { value: 1800 })
    element.scrollTop = 200 // browser clamps the old reading position on resize
    act(() => { resize(); result.current.handleTimelineScroll() })
    rerender({ ...options, timeline: [] })
    expect(element.scrollTop).toBe(200)
    rerender({ ...options, sessionPath: '/b', timeline: [] })
    expect(element.scrollTop).toBe(2000)
  })

  it('does not reenable following from a near-bottom history jump or its scroll event', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const element = document.createElement('div')
    Object.defineProperties(element, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } })
    const target = document.createElement('div')
    target.dataset.entryId = 'near-end'
    document.body.append(element)
    target.getBoundingClientRect = () => ({ top: 1702 - element.scrollTop } as DOMRect)
    element.append(target)
    const options: Parameters<typeof useConversationNavigation>[0] = {
      scrollRef: { current: element }, timeline: [{ kind: 'user', id: 1, text: 'near end' }], timelineMutation: 'replace', busy: true,
      historyJump: { entryId: 'near-end', nonce: 1 }, panelsVisible: false,
      loadOlder: vi.fn(async () => undefined), loadNewer: vi.fn(async () => undefined)
    }
    const { result, rerender } = renderHook((props) => useConversationNavigation(props), { initialProps: options })
    settleFrames(frames)
    act(() => result.current.handleTimelineScroll())
    rerender({ ...options, timeline: [...options.timeline], panelsVisible: true })
    expect(element.scrollTop).toBe(1550)
    // Deliberate scrolling back to the bottom restores normal live following.
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
    element.scrollTop = 1600
    act(() => result.current.handleTimelineScroll())
    rerender({ ...options, timeline: [...options.timeline], panelsVisible: false })
    expect(element.scrollTop).toBe(2000)
  })

  it('keeps the exact clicked short message selected, including when the viewport clamps its position', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const element = document.createElement('div')
    Object.defineProperties(element, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } })
    const previous = document.createElement('div')
    const target = document.createElement('div')
    previous.className = target.className = 'row-user'
    previous.dataset.entryId = 'previous'
    target.dataset.entryId = 'clicked'
    document.body.append(element)
    previous.getBoundingClientRect = () => ({ top: 860 - element.scrollTop } as DOMRect)
    target.getBoundingClientRect = () => ({ top: 880 - element.scrollTop } as DOMRect)
    element.append(previous, target)
    const options: Parameters<typeof useConversationNavigation>[0] = {
      scrollRef: { current: element }, timeline: [], timelineMutation: 'replace', busy: true,
      historyJump: { entryId: 'clicked', nonce: 1 },
      loadOlder: vi.fn(async () => undefined), loadNewer: vi.fn(async () => undefined)
    }
    const { result, rerender } = renderHook((props) => useConversationNavigation(props), { initialProps: options })
    settleFrames(frames)
    expect(element.scrollTop).toBe(600) // target cannot reach the anchor at the document's end
    expect(target).toHaveProperty('className', 'row-user history-jump-target')
    act(() => result.current.handleTimelineScroll())
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(result.current.visibleHistoryEntryId).toBe('clicked')
    rerender({ ...options, timeline: [], busy: false })
    expect(result.current.visibleHistoryEntryId).toBe('clicked')
    // Genuine scrolling releases the explicit selection and tracks visible rows again.
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }))
    element.scrollTop -= 20
    act(() => result.current.handleTimelineScroll())
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(result.current.visibleHistoryEntryId).toBe('previous')
  })

  it('aligns adjacent messages to the same anchor used for active-row tracking', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const element = document.createElement('div')
    Object.defineProperties(element, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } })
    document.body.append(element)
    const rows = ['previous', 'clicked'].map((id, index) => {
      const row = document.createElement('div')
      row.className = 'row-user'
      row.dataset.entryId = id
      row.getBoundingClientRect = () => ({ top: 620 + index * 20 - element.scrollTop, height: 18 } as DOMRect)
      element.append(row)
      return row
    })
    const options: Parameters<typeof useConversationNavigation>[0] = {
      scrollRef: { current: element }, timeline: [], timelineMutation: 'replace', busy: false,
      historyJump: { entryId: 'clicked', nonce: 1 },
      loadOlder: async () => undefined, loadNewer: async () => undefined
    }
    const { result } = renderHook(() => useConversationNavigation(options))
    settleFrames(frames)
    expect(rows[1].getBoundingClientRect().top).toBe(152)
    act(() => result.current.handleTimelineScroll())
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(result.current.visibleHistoryEntryId).toBe('clicked')
  })

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
    document.body.append(element)
    target.getBoundingClientRect = () => ({ top: 652 - element.scrollTop } as DOMRect)
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
    settleFrames(frames)
    expect(element.scrollTop).toBe(500)
    // A same-session refresh may replace the array while keeping mutation=replace.
    rerender({ ...options, timeline: [...timeline] })
    expect(element.scrollTop).toBe(500)
    // No browser scroll event is dispatched: the jump must update follow state itself.
    rerender({ ...options, busy: false, panelsVisible: true })
    expect(element.scrollTop).toBe(500)
    Object.defineProperty(element, 'scrollHeight', { value: 2200 })
    rerender({ ...options, timeline: [...timeline], timelineMutation: 'append' })
    expect(element.scrollTop).toBe(500)
  })
})
