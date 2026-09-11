// @vitest-environment jsdom
import { useCallback, useLayoutEffect, useRef } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import type { TimelineItem } from '../../src/renderer/src/agent/types'

type NavigationOptions = Omit<Parameters<typeof useConversationNavigation>[0], 'scrollRef'>
type LayoutSnapshot = { minHeight: string; height: number; top: number }
type HarnessProps = NavigationOptions & { height: number; onLayout: (snapshot: LayoutSnapshot) => void }

const frames = new Map<number, FrameRequestCallback>()
const resizes = new Set<() => void>()

function flushFrames() {
  act(() => {
    const queued = [...frames.values()]
    frames.clear()
    queued.forEach((callback) => callback(0))
  })
}

// Like loadingScroll's clamped geometry, but attach both refs in a mounted
// tree so the hook sees the surface and the new content in its FIRST layout.
function Harness({ height, onLayout, ...options }: HarnessProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const navigation = useConversationNavigation({ ...options, scrollRef })
  const attachViewport = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element
    if (!element) return
    const surface = element.querySelector<HTMLElement>('.chat-scroll-surface')!
    const content = element.querySelector<HTMLElement>('.timeline')!
    let top = 0
    const totalHeight = () => Math.max(400, Number(content.dataset.height), parseFloat(surface.style.minHeight) || 0)
    Object.defineProperty(content, 'offsetHeight', { get: () => Number(content.dataset.height) })
    Object.defineProperties(element, {
      clientHeight: { value: 400 },
      scrollHeight: { get: totalHeight },
      scrollTop: {
        get: () => { top = Math.max(0, Math.min(top, totalHeight() - 400)); return top },
        set: (value: number) => { top = Math.max(0, Math.min(value, totalHeight() - 400)) }
      }
    })
    surface.getBoundingClientRect = () => ({ height: totalHeight() } as DOMRect)
  }, [])
  useLayoutEffect(() => {
    const element = scrollRef.current!
    onLayout({
      minHeight: navigation.scrollSurfaceRef.current!.style.minHeight,
      height: element.scrollHeight,
      top: element.scrollTop
    })
  })
  return <>
    <div ref={attachViewport} data-testid="viewport" onScroll={navigation.handleTimelineScroll}>
      <div ref={navigation.scrollSurfaceRef} className="chat-scroll-surface" data-testid="surface">
        <div className="timeline" data-height={height}>
          {options.timeline.map((item, index) => <div
            key={item.id}
            className={item.kind === 'user' ? 'row-user' : 'row-assistant'}
            data-entry-id={'entryId' in item ? item.entryId : undefined}
            data-top={250 + index * 300}
            ref={(row) => {
              if (!row) return
              Object.defineProperty(row, 'offsetTop', { configurable: true, get: () => Number(row.dataset.top) })
              row.getBoundingClientRect = () => ({ top: row.offsetTop - (scrollRef.current?.scrollTop ?? 0), height: 24 } as DOMRect)
            }}
          >{'text' in item ? item.text : item.kind}</div>)}
        </div>
      </div>
    </div>
    <output data-testid="visible-entry">{navigation.visibleHistoryEntryId}</output>
  </>
}

const shared: TimelineItem = { kind: 'user', id: 1, entryId: 'shared', text: 'surviving prompt' }
const tail: TimelineItem = { kind: 'user', id: 2, entryId: 'tail', text: 'surviving tail' }
const removed: TimelineItem = { kind: 'user', id: 3, entryId: 'removed', text: 'undone prompt' }

function setup(patch: Partial<NavigationOptions & { height: number }> = {}) {
  const loadOlder = vi.fn(async () => undefined)
  const loadNewer = vi.fn(async () => undefined)
  const commits: LayoutSnapshot[] = []
  let props: HarnessProps = {
    timeline: [shared, tail, removed], timelineMutation: 'replace', busy: false,
    timelineLoading: false, projectCwd: '/project', sessionPath: '/project/a.jsonl',
    historyIndexSessionPath: '/project/a.jsonl', historyJump: null, historyResetRevision: 0,
    height: 4000, loadOlder, loadNewer, ...patch,
    onLayout: (snapshot) => { commits.push(snapshot) }
  }
  const view = render(<Harness {...props} />)
  const element = view.getByTestId('viewport') as HTMLDivElement
  const surface = view.getByTestId('surface') as HTMLDivElement
  const content = surface.querySelector<HTMLElement>('.timeline')!
  return {
    ...view, element, surface, content, commits, loadOlder, loadNewer,
    update: (next: Partial<NavigationOptions & { height: number }>) => {
      props = { ...props, ...next }
      view.rerender(<Harness {...props} />)
    },
    scrollUp: (top = 1000) => {
      fireEvent.wheel(element, { deltaY: -500 })
      element.scrollTop = top
      fireEvent.scroll(element)
    },
    resizeContent: (height: number) => {
      content.dataset.height = String(height)
      act(() => [...resizes].forEach((callback) => callback()))
    }
  }
}

describe('message revert navigation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    let frameId = 0
    frames.clear()
    resizes.clear()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++frameId, callback)
      return frameId
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: () => void) { resizes.add(callback) }
      observe() {}
      disconnect() { resizes.delete(this.callback) }
    })
  })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it.each([180, 900])('releases the old reading range in the first layout of an undo to a %ipx branch', async (height) => {
    const h = setup()
    h.scrollUp()
    expect(h.surface.style.minHeight).toBe('4000px')
    expect(h.element.scrollTop).toBe(1000)
    const firstCommit = h.commits.length
    h.update({ timeline: [shared], height, historyResetRevision: 1 })
    // No frame, observer delivery or user scroll is needed to remove the tail.
    expect(h.commits[firstCommit]).toEqual({ minHeight: '', height: Math.max(400, height), top: Math.max(0, height - 400) })
    expect(h.getByTestId('viewport')).toBe(h.element)
    expect(h.getByTestId('surface')).toBe(h.surface)
    await act(async () => {}) // allow only the new short viewport's normal fill
    expect(h.loadOlder).toHaveBeenCalledTimes(height < 400 ? 1 : 0)
    expect(h.loadNewer).toHaveBeenCalledTimes(height < 400 ? 1 : 0)

    // A delayed old-gesture scroll (still within 300ms) must not recreate manual
    // preservation, or trigger another page at the new window's top boundary.
    h.element.scrollTop = 20
    fireEvent.scroll(h.element)
    h.update({ busy: true })
    expect(h.surface.style.minHeight).toBe('')
    expect(h.element.scrollTop).toBe(Math.max(0, height - 400))
    flushFrames()
    expect(h.loadOlder).toHaveBeenCalledTimes(height < 400 ? 1 : 0)
    expect(h.loadNewer).toHaveBeenCalledTimes(height < 400 ? 1 : 0)

    // Undo deliberately navigated to the new tail, including late image/layout
    // growth. Fresh upward input on that branch must still pause live following.
    h.resizeContent(2000)
    expect(h.element.scrollTop).toBe(1600)
    h.scrollUp(600)
    h.update({ height: 2400, timeline: [shared, tail], timelineMutation: 'append' })
    h.resizeContent(2800)
    expect(h.element.scrollTop).toBe(600)
  })

  it.each([0, 180, 900])('uses fresh loading space and the actual %ipx branch after a same-session undo clear', async (height) => {
    const h = setup()
    h.scrollUp()
    h.update({ timeline: [], height: 0, timelineLoading: true, historyResetRevision: 1 })
    // Keep the normal loading affordance, not the removed branch's 4000px range.
    expect(h.surface.style.minHeight).toBe('1200px')
    expect(h.element.scrollTop).toBe(0)
    h.element.scrollTop = 20
    fireEvent.scroll(h.element)
    expect(h.loadOlder).not.toHaveBeenCalled()
    const firstCommit = h.commits.length
    h.update({ timeline: height === 0 ? [] : [shared], height, timelineLoading: false })
    expect(h.commits[firstCommit]).toEqual({ minHeight: '', height: Math.max(400, height), top: Math.max(0, height - 400) })
    await act(async () => {})
    fireEvent.scroll(h.element)
    h.update({ busy: true })
    expect(h.surface.style.minHeight).toBe('')
    expect(h.element.scrollHeight).toBe(Math.max(400, height))
    // Empty history can keep the same item count as the loading shell, so no
    // additional fill is required there; nonempty short history fills only once.
    expect(h.loadOlder).toHaveBeenCalledTimes(height > 0 && height < 400 ? 1 : 0)
    expect(h.loadNewer).toHaveBeenCalledTimes(height > 0 && height < 400 ? 1 : 0)
  })

  it.each([undefined, 7])('preserves ordinary same-session replacement reading with revision %s', (historyResetRevision) => {
    const h = setup({ historyResetRevision })
    h.scrollUp()
    h.update({ timeline: [], height: 0, timelineLoading: true })
    h.update({ timeline: [shared], height: 900, timelineLoading: false })
    expect(h.surface.style.minHeight).toBe('4000px')
    expect(h.element.scrollHeight).toBe(4000)
    expect(h.element.scrollTop).toBe(1000)
    h.update({ busy: true, panelsVisible: true, timeline: [{ ...shared }] })
    h.resizeContent(900)
    expect(h.element.scrollTop).toBe(1000)
    expect(h.surface.style.minHeight).toBe('4000px')
    h.update({ timeline: [shared, tail], height: 1400, timelineMutation: 'append' })
    expect(h.element.scrollTop).toBe(1000)
    expect(h.loadOlder).not.toHaveBeenCalled()
    expect(h.loadNewer).not.toHaveBeenCalled()
  })

  it.each([false, true])('discards an old branch jump and highlight on undo (jump already applied: %s)', (applied) => {
    const h = setup()
    h.scrollUp()
    h.update({ historyJump: { entryId: 'shared', nonce: 1 } })
    const row = h.content.querySelector<HTMLElement>('[data-entry-id="shared"]')!
    if (applied) {
      flushFrames()
      expect(h.element.scrollTop).toBe(98)
      expect(row.classList.contains('history-jump-target')).toBe(true)
      expect(h.getByTestId('visible-entry').textContent).toBe('shared')
    }
    // Keep the ancestor DOM and old nonce: the explicit reset must invalidate
    // them itself, rather than relying on unmounting or a different session ID.
    h.update({ timeline: [shared, tail], height: 900, historyResetRevision: 1 })
    expect(h.element.scrollTop).toBe(500)
    expect(row.classList.contains('history-jump-target')).toBe(false)
    expect(h.getByTestId('visible-entry').textContent).toBe('')
    flushFrames()
    expect(h.element.scrollTop).toBe(500)
    expect(h.getByTestId('visible-entry').textContent).toBe('tail')
    act(() => vi.advanceTimersByTime(1600))
    expect(row.classList.contains('history-jump-target')).toBe(false)
    expect(h.loadOlder).not.toHaveBeenCalled()
    expect(h.loadNewer).not.toHaveBeenCalled()
  })

  it('cancels old viewport-fill continuations even when undo preserves the session, jump and item count', async () => {
    const finish: Array<() => void> = []
    const loadOlder = vi.fn(() => new Promise<void>((resolve) => { finish.push(resolve) }))
    const loadNewer = vi.fn(async () => undefined)
    const h = setup({ timeline: [shared], height: 180, loadOlder, loadNewer })
    expect(loadOlder).toHaveBeenCalledTimes(1)
    // No timeline identity/count, loader or jump change can incidentally cancel
    // the old fill: only the branch revision changes its paging owner.
    h.update({ historyResetRevision: 1 })
    expect(loadOlder).toHaveBeenCalledTimes(2)
    await act(async () => { finish[0]() })
    expect(loadNewer).not.toHaveBeenCalled()
    fireEvent.wheel(h.element, { deltaY: 80 })
    expect(loadNewer).not.toHaveBeenCalled() // old completion cannot clear the new guard
    await act(async () => { finish[1]() })
    expect(loadNewer).toHaveBeenCalledTimes(1)
    expect(loadNewer).toHaveBeenCalledWith(undefined)
    expect(h.surface.style.minHeight).toBe('')
    expect(h.element.scrollHeight).toBe(400)
  })

  it('honors fresh manual input during the new branch loading instead of forcing undo follow again', () => {
    const h = setup()
    h.scrollUp()
    h.update({ timeline: [], height: 0, timelineLoading: true, historyResetRevision: 1 })
    fireEvent.wheel(h.element, { deltaY: -100 })
    h.update({ timeline: [shared], height: 2000, timelineLoading: false })
    expect(h.element.scrollTop).toBe(0)
    h.update({ timeline: [shared, tail], height: 2400, timelineMutation: 'append' })
    h.resizeContent(2800)
    expect(h.element.scrollTop).toBe(0)
    fireEvent.keyDown(h.element, { key: 'End' })
    expect(h.surface.style.minHeight).toBe('')
    expect(h.element.scrollTop).toBe(2400)
  })
})
