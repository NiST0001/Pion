// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { createRef, StrictMode } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatTimeline } from '../../src/renderer/src/features/chat/ChatTimeline'
import type { ChatTimelineProps } from '../../src/renderer/src/features/chat/ChatTimeline'
import type { TimelineItem } from '../../src/renderer/src/agent/types'
import { REVIEW_REVEAL_CHUNK_SIZE } from '../../src/renderer/src/features/review/ReviewRevealText'
import {
  SCREEN_TEXT_REVEAL_MAX_DELAY_MS, SCREEN_TEXT_REVEAL_DURATION_MS, SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS,
  SCREEN_TEXT_REVEAL_LIVE_DURATION_MS, SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS
} from '../../src/renderer/src/utils/screenTextReveal'

function emptyTimelineProps(): ChatTimelineProps {
  return {
    scrollRef: createRef<HTMLDivElement>(),
    onScroll: vi.fn(),
    timeline: [],
    timelineLoading: false,
    busy: false,
    starting: false,
    cwd: '/project',
    hasSessions: true,
    canFork: false,
    onFork: vi.fn(),
    agentActivity: false,
    workingStatus: { label: '' }
  }
}

describe('ChatTimeline viewport reveal scheduling', () => {
  const history = (id = 1) => ({ kind: 'user' as const, id, text: `历史${id}`, historical: true })
  const props = (): ChatTimelineProps => ({ ...emptyTimelineProps(), scopeKey: 'session-a', timeline: [history()] })
  let frames: Map<number, FrameRequestCallback>
  let cancelled: FrameRequestCallback[]
  let frameId: number
  const flushFrame = async (beforeCommit?: () => void) => {
    await act(async () => {
      await Promise.resolve() // MutationObserver merges all committed changes.
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach(callback => callback(performance.now()))
      beforeCommit?.() // A scheduled admission is not yet committed character DOM.
      await Promise.resolve()
    })
  }
  const invoke = (callbacks: FrameRequestCallback[]) => act(() => callbacks.forEach(callback => callback(1000)))

  beforeEach(() => {
    vi.useFakeTimers()
    frames = new Map(); cancelled = []; frameId = 0
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      const id = ++frameId; frames.set(id, callback); return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      const callback = frames.get(id)
      if (callback) cancelled.push(callback)
      frames.delete(id)
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.classList.contains('chat-scroll') ? 100 : 120
      const height = this.classList.contains('chat-scroll') ? 600 : 20
      return { top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON() {} }
    })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

  it('merges history, tokens and paging before the first frame without a live row jumping the queue', async () => {
    const p = props()
    const restored = p.timeline[0]
    const live = { kind: 'assistant' as const, id: 2, text: 'token', thinking: '', streaming: true, live: true }
    const view = render(<ChatTimeline {...p} timeline={[restored, live]} />)
    const main = p.scrollRef.current
    const bubble = view.container.querySelector<HTMLElement>('.bubble-user')!
    const liveBubble = view.container.querySelector<HTMLElement>('.bubble-assistant')!
    expect(main).toHaveAttribute('data-line-reveal-owner', 'true')
    expect(liveBubble).not.toHaveAttribute('data-line-reveal-ready')
    let text = live.text
    for (const suffix of ['一', '二']) {
      text += suffix
      view.rerender(<ChatTimeline {...p} timeline={[restored, { ...live, text }]} />)
    }
    view.rerender(<ChatTimeline {...p} timeline={[restored, history(3), { ...live, text }]} />)
    const added = view.container.querySelectorAll<HTMLElement>('.bubble-user')[1]
    expect(bubble).not.toHaveAttribute('data-line-reveal-ready')
    expect(added).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame() // Only the first parent line may enter before its text.
    expect(bubble).toHaveAttribute('data-line-reveal-start', '1000')
    expect(bubble.querySelector('[data-text-reveal-pending="true"]')).not.toBeNull()
    expect(added).not.toHaveAttribute('data-line-reveal-ready')
    expect(liveBubble).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame() // Commit the first row's characters, not the next row.
    expect(bubble.querySelector('[data-text-reveal-pending]')).toBeNull()
    expect(added).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame() // The next line is now eligible, but its text still blocks live.
    expect(added).toHaveAttribute('data-line-reveal-start', '1020')
    expect(liveBubble).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame()
    expect(added.querySelector('[data-text-reveal-pending]')).toBeNull()
    expect(liveBubble).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame()
    expect([bubble, added, liveBubble].map(element => Number(element.dataset.lineRevealStart)))
      .toEqual([1000, 1020, 1040])
    const firstLiveLine = liveBubble.querySelector<HTMLElement>('.screen-text-reveal-line')!
    expect(firstLiveLine.dataset.lineRevealStart).toBe(liveBubble.dataset.lineRevealStart)
    const delays = [bubble, added, liveBubble].map(element => element.style.getPropertyValue('--screen-text-reveal-delay'))
    view.rerender(<ChatTimeline {...p} timeline={[restored, history(3), { ...live, text: text + '三' }]} />)
    await flushFrame()
    expect(p.scrollRef.current).toBe(main)
    expect(view.container.querySelector('.bubble-user')).toBe(bubble)
    expect(view.container.querySelector('.bubble-assistant')).toBe(liveBubble)
    expect([bubble, added, liveBubble].map(element => element.style.getPropertyValue('--screen-text-reveal-delay'))).toEqual(delays)
    expect(bubble).toHaveClass('screen-text-reveal-line-history')
    expect(p.onScroll).not.toHaveBeenCalled()
  })

  it('waits for a slow history character commit before starting lower live Markdown behind an older text tail', async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      const row = this.closest('.row')
      const index = row?.parentElement ? [...row.parentElement.children].indexOf(row) : 0
      const top = this.classList.contains('chat-scroll') ? 100 : 120 + index * 60
      const height = this.classList.contains('chat-scroll') ? 600 : 20
      return { top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON() {} }
    })
    const p = props()
    const older = { ...history(9), text: '旧'.repeat(REVIEW_REVEAL_CHUNK_SIZE) }
    const view = render(<ChatTimeline {...p} timeline={[older]} />)
    const main = p.scrollRef.current
    const oldBubble = view.container.querySelector<HTMLElement>('.bubble-user')!
    await flushFrame() // Parent line.
    await flushFrame() // Actual characters establish a future shared text tail.
    const oldCharacters = [...oldBubble.querySelectorAll<HTMLElement>('[data-screen-reveal-character]')]
    expect(oldCharacters).toHaveLength(REVIEW_REVEAL_CHUNK_SIZE)
    const oldDelay = oldCharacters[0].style.getPropertyValue('--screen-text-reveal-delay')
    const oldDeadline = 1000 + SCREEN_TEXT_REVEAL_MAX_DELAY_MS
      + SCREEN_TEXT_REVEAL_DURATION_MS + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS
    await flushFrame() // Drain the old commit's mutation wake, not a polling loop.

    const upper = history()
    const live = { kind: 'assistant' as const, id: 2, text: 'token', thinking: '', streaming: true, live: true }
    view.rerender(<ChatTimeline {...p} timeline={[older, upper, live]} />)
    const upperBubble = view.container.querySelectorAll<HTMLElement>('.bubble-user')[1]
    const upperChunk = upperBubble.querySelector<HTMLElement>('[data-text-reveal-pending]')!
    const liveBubble = view.container.querySelector<HTMLElement>('.bubble-assistant')!
    const liveLine = liveBubble.querySelector<HTMLElement>('.screen-text-reveal-line')!
    const liveCharacter = liveLine.querySelector<HTMLElement>('.screen-text-reveal-live')!
    const expectLowerPending = () => {
      expect(liveBubble).not.toHaveAttribute('data-line-reveal-ready')
      expect(liveLine).not.toHaveAttribute('data-line-reveal-ready')
      expect(liveLine.querySelector('.screen-text-reveal-live')).toBe(liveCharacter)
      expect(liveCharacter.style.animationPlayState).toBe('paused')
    }
    await flushFrame()
    expect(upperBubble).toHaveAttribute('data-line-reveal-start', '1020')
    expect(upperChunk).toHaveAttribute('data-text-reveal-pending', 'true')
    expect(upperChunk).not.toHaveAttribute('data-text-reveal-start')
    expectLowerPending()

    const advanceTo = (at: number) => {
      const elapsed = at - performance.now()
      vi.mocked(performance.now).mockReturnValue(at)
      act(() => vi.advanceTimersByTime(elapsed))
    }
    advanceTo(1050) // A slow next frame must not let the old 20ms line slot win.
    expectLowerPending()
    await flushFrame(() => {
      // All RAF callbacks have run, but React has not committed the admission.
      expect(upperChunk).toHaveAttribute('data-text-reveal-pending', 'true')
      expect(upperChunk.querySelector('[data-screen-reveal-character]')).toBeNull()
      expectLowerPending()
    })
    expect(upperChunk).not.toHaveAttribute('data-text-reveal-pending')
    expect(upperChunk.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(upper.text.length)
    const textStart = Number(upperChunk.dataset.textRevealStart)
    expect(textStart).toBe(1000 + SCREEN_TEXT_REVEAL_MAX_DELAY_MS)
    expect(textStart).toBeGreaterThan(performance.now())
    expectLowerPending()

    await flushFrame() // Only the committed start can release the lower line.
    expect(liveLine).toHaveAttribute('data-line-reveal-ready', 'true')
    expect(Number(liveLine.dataset.lineRevealStart)).toBeGreaterThanOrEqual(textStart)
    expect(liveBubble.dataset.lineRevealStart).toBe(liveLine.dataset.lineRevealStart)
    expect(liveLine.querySelector('.screen-text-reveal-live')).toBe(liveCharacter)
    expect(liveCharacter.style.animationPlayState).not.toBe('paused')
    const lineDelay = liveLine.style.getPropertyValue('--screen-text-reveal-delay')
    const characterDelay = liveCharacter.style.getPropertyValue('--screen-text-reveal-delay')
    const liveDeadline = Math.ceil(Number(liveLine.dataset.lineRevealStart)
      + (live.text.length - 1) * SCREEN_TEXT_REVEAL_LIVE_STAGGER_MS
      + SCREEN_TEXT_REVEAL_LIVE_DURATION_MS + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS)

    advanceTo(1060)
    view.rerender(<ChatTimeline {...p} timeline={[older, upper, { ...live, streaming: false, live: false }]} />)
    await flushFrame()
    expect(p.scrollRef.current).toBe(main)
    expect(view.container.querySelector('.bubble-user')).toBe(oldBubble)
    expect(view.container.querySelector('.bubble-assistant')).toBe(liveBubble)
    expect(liveBubble.querySelector('.screen-text-reveal-line')).toBe(liveLine)
    expect(liveLine.querySelector('.screen-text-reveal-live')).toBe(liveCharacter)
    expect(liveLine.style.getPropertyValue('--screen-text-reveal-delay')).toBe(lineDelay)
    expect(liveCharacter.style.getPropertyValue('--screen-text-reveal-delay')).toBe(characterDelay)
    expect(oldCharacters[0].style.getPropertyValue('--screen-text-reveal-delay')).toBe(oldDelay)
    advanceTo(oldDeadline - 1)
    expect(oldBubble.querySelector('[data-screen-reveal-character]')).toBe(oldCharacters[0])
    advanceTo(oldDeadline)
    expect(oldBubble.querySelector('[data-screen-reveal-character]')).toBeNull()
    advanceTo(liveDeadline - 1)
    expect(liveLine.querySelector('.screen-text-reveal-live')).toBe(liveCharacter)
    advanceTo(liveDeadline)
    expect(liveLine.querySelector('.screen-text-reveal-live')).toBeNull()
    expect(view.container.querySelector('.bubble-user')).toBe(oldBubble)
    expect(liveBubble.querySelector('.screen-text-reveal-line')).toBe(liveLine)
    expect(p.onScroll).not.toHaveBeenCalled()
  })

  it('orders historical compaction summaries with their surrounding rows and honors noReveal', async () => {
    const p = props()
    const compaction = { kind: 'compaction' as const, id: 2, summary: '压缩摘要', historical: true }
    const view = render(<ChatTimeline {...p} timeline={[history(), compaction, history(3)]} />)
    const marker = view.container.querySelector<HTMLElement>('.compaction-marker')!
    expect(marker.querySelector('[data-screen-reveal-character]')).toBeNull()
    const rows = [view.container.querySelector('.bubble-user')!, marker, view.container.querySelectorAll('.bubble-user')[1]] as HTMLElement[]
    await flushFrame()
    expect(rows[0]).toHaveAttribute('data-line-reveal-start', '1000')
    expect(marker).not.toHaveAttribute('data-line-reveal-ready')
    expect(rows[2]).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame() // Commit the user text before admitting the summary line.
    expect(rows[0].querySelector('[data-text-reveal-pending]')).toBeNull()
    expect(marker).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame()
    expect(marker).toHaveAttribute('data-line-reveal-start', '1020')
    expect(marker.querySelector('[data-screen-reveal-character]')).toBeNull()
    expect(rows[2]).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame() // The summary's real character commit releases the last row.
    expect(marker.querySelectorAll('[data-screen-reveal-character]')).toHaveLength(compaction.summary.length)
    expect(rows[2]).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame()
    expect(rows.map(element => Number(element.dataset.lineRevealStart))).toEqual([1000, 1020, 1040])
    await flushFrame()
    expect(view.container.querySelector('.compaction-marker')).toBe(marker)
    expect(rows[2].querySelector('[data-text-reveal-pending]')).toBeNull()
    view.rerender(<ChatTimeline {...p} timeline={[{ ...compaction, id: 4, noReveal: true }]} />)
    await flushFrame()
    const plain = view.container.querySelector('.compaction-marker')!
    expect(plain).not.toHaveAttribute('data-line-reveal-ready')
    expect(plain.querySelector('[data-screen-reveal-character]')).toBeNull()
    expect(plain).toHaveTextContent(compaction.summary)
  })

  it('observes same-length replacements while leaving noReveal and plain content alone', async () => {
    const p = props()
    const suppressed = { ...history(2), noReveal: true }
    const plain = { kind: 'assistant' as const, id: 3, text: '静态正文', thinking: '', streaming: false, noReveal: true }
    const view = render(<ChatTimeline {...p} timeline={[history(), suppressed, plain]} />)
    await flushFrame()
    expect(view.container.querySelector('.bubble-user')).toHaveAttribute('data-line-reveal-ready', 'true')
    const suppressedBubble = view.container.querySelectorAll('.bubble-user')[1]
    const plainBubble = view.container.querySelector('.bubble-assistant')
    view.rerender(<ChatTimeline {...p} timeline={[history(4), suppressed, plain]} />)
    const replacement = view.container.querySelector('.bubble-user')!
    expect(replacement).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame()
    expect(replacement).toHaveAttribute('data-line-reveal-ready', 'true')
    for (const bubble of [suppressedBubble, plainBubble]) {
      expect(bubble).not.toHaveAttribute('data-line-reveal-ready')
      expect(bubble).not.toHaveClass('screen-text-reveal-line')
      expect(bubble?.querySelector('[data-screen-reveal-character]')).toBeNull()
      expect(bubble?.isConnected).toBe(true)
    }
  })

  it('rejects StrictMode replay and old-scope frames even when the same scope and container return', async () => {
    const p = props()
    const view = render(<StrictMode><ChatTimeline {...p} /></StrictMode>)
    const main = p.scrollRef.current
    expect(cancelled.length).toBeGreaterThan(0)
    invoke(cancelled)
    expect(view.container.querySelector('.bubble-user')).not.toHaveAttribute('data-line-reveal-ready')
    const firstVisit = [...frames.values()]
    view.rerender(<StrictMode><ChatTimeline {...p} scopeKey="session-b" timeline={[history(2)]} /></StrictMode>)
    const otherScope = [...frames.values()]
    invoke(firstVisit)
    expect(view.container.querySelector('.bubble-user')).not.toHaveAttribute('data-line-reveal-ready')
    view.rerender(<StrictMode><ChatTimeline {...p} timeline={[history(3)]} /></StrictMode>)
    invoke([...firstVisit, ...otherScope])
    expect(view.container.querySelector('.bubble-user')).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame()
    expect(view.container.querySelector('.bubble-user')).toHaveAttribute('data-line-reveal-ready', 'true')
    expect(p.scrollRef.current).toBe(main)
  })

  it('retires hidden and unmounted owners and reveals the same mounted rows after showing', async () => {
    const p = props()
    const view = render(<ChatTimeline {...p} />)
    const main = p.scrollRef.current
    const bubble = view.container.querySelector('.bubble-user')!
    const beforeHide = [...frames.values()]
    view.rerender(<ChatTimeline {...p} hidden />)
    invoke(beforeHide)
    await flushFrame()
    expect(bubble).not.toHaveAttribute('data-line-reveal-ready')
    view.rerender(<ChatTimeline {...p} />)
    invoke(beforeHide)
    expect(bubble).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame()
    expect(bubble).toHaveAttribute('data-line-reveal-ready', 'true')
    expect(p.scrollRef.current).toBe(main)
    expect(view.container.querySelector('.bubble-user')).toBe(bubble)
    view.rerender(<ChatTimeline {...p} timeline={[history(2)]} />)
    await act(async () => { await Promise.resolve() })
    const detached = view.container.querySelector('.bubble-user')!
    const beforeUnmount = [...frames.values()]
    view.unmount()
    invoke(beforeUnmount)
    await flushFrame()
    expect(detached).not.toHaveAttribute('data-line-reveal-ready')
    expect(frames.size).toBe(0)
  })

  it('rebinds a changed scroll ref without allowing its old callback to admit rows', async () => {
    const p = props()
    const view = render(<ChatTimeline {...p} />)
    const firstCallbacks = [...frames.values()]
    const main = p.scrollRef.current!
    const bubble = view.container.querySelector('.bubble-user')!
    const nextRef = createRef<HTMLDivElement>()
    view.rerender(<ChatTimeline {...p} scrollRef={nextRef} />)
    expect(p.scrollRef.current).toBeNull()
    expect(nextRef.current).toBe(main)
    invoke(firstCallbacks)
    expect(bubble).not.toHaveAttribute('data-line-reveal-ready')
    await flushFrame()
    expect(bubble).toHaveAttribute('data-line-reveal-ready', 'true')
    expect(view.container.querySelector('.bubble-user')).toBe(bubble)
  })
})

describe('ChatTimeline per-turn changes', () => {
  afterEach(cleanup)

  it('keeps App timeline bindings and turn cards independent of Git snapshots and review navigation', () => {
    const app = readFileSync(resolve('src/renderer/src/App.tsx'), 'utf8')
    const timeline = readFileSync(resolve('src/renderer/src/features/chat/ChatTimeline.tsx'), 'utf8')
    const bindings = [
      ...app.matchAll(/<ChatTimeline\b[\s\S]*?\/>/g),
      ...timeline.matchAll(/<ModifiedFilesCard\b[\s\S]*?\/>/g)
    ]
    expect(bindings.length).toBeGreaterThanOrEqual(3)
    for (const [binding] of bindings) {
      expect(binding).not.toMatch(/\b(?:latestRunChanges|workspaceChanges|gitSnapshot|runCheckpoint|checkpoint\w*|onReview|onSelectChange|onRevertLatest)\s*=/)
    }
    expect(timeline).not.toMatch(/\b(?:GitSnapshot|useGit|window\.pion\.git)\b/)
  })

  const edit = (id: number, path: string, diff: string): TimelineItem => ({
    kind: 'tool', id, tool: { id: `edit-${id}`, name: 'edit', path, diff, status: 'done', isError: false, resultReceived: true }
  })
  const user = (id: number): TimelineItem => ({ kind: 'user', id, text: `请求${id}` })
  const answer = (id: number): TimelineItem => ({ kind: 'assistant', id, text: `回复${id}`, thinking: '', streaming: false })

  it('places each card after its own turn and independently previews that turn’s recorded diff for the same path', () => {
    const props = emptyTimelineProps()
    const firstDiff = '-1 old\n+1 first'
    const secondDiff = '-1 first\n-2 middle\n+1 second\n+2 next\n+3 end'
    props.timeline = [
      user(1), edit(2, '/project/shared.ts', firstDiff), edit(3, '/project/first.ts', '+a\n+b'), answer(4),
      user(5), edit(6, '/project/shared.ts', secondDiff), edit(7, '/project/second.ts', '+c'), answer(8)
    ]
    const view = render(<ChatTimeline {...props} />)
    const cards = view.getAllByRole('region', { name: '本轮工具记录' })
    const replies = view.container.querySelectorAll('.row-assistant')
    const users = view.container.querySelectorAll('.row-user')
    expect(cards).toHaveLength(2)
    expect(cards[0].previousElementSibling).toBe(replies[0])
    expect(cards[0].nextElementSibling).toBe(users[1])
    expect(cards[1].previousElementSibling).toBe(replies[1])
    expect(cards[1].nextElementSibling).toBeNull()
    expect(cards[0]).toHaveTextContent('first.ts')
    expect(cards[0]).not.toHaveTextContent('second.ts')
    expect(cards[1]).toHaveTextContent('second.ts')
    expect(cards[1]).not.toHaveTextContent('first.ts')
    for (const [index, card] of cards.entries()) {
      expect(card).toHaveTextContent('本轮记录 2 个文件')
      expect(card.querySelector('.modified-files-total .stat-add')).toHaveTextContent(index === 0 ? '+3' : '+4')
      expect(card.querySelector('.modified-files-total .stat-del')).toHaveTextContent(index === 0 ? '−1' : '−2')
      expect(card.querySelector('.diff-view')).toBeNull()
    }
    fireEvent.click(within(cards[0]).getByTitle('查看 /project/shared.ts 的本轮记录'))
    const firstPreview = cards[0].querySelector('.diff-view')!
    expect([...firstPreview.querySelectorAll('.diff-text')].map(line => line.textContent)).toEqual(['old', 'first'])
    expect(cards[1].querySelector('.diff-view')).toBeNull()

    fireEvent.click(within(cards[1]).getByTitle('查看 /project/shared.ts 的本轮记录'))
    const secondPreview = cards[1].querySelector('.diff-view')!
    expect([...secondPreview.querySelectorAll('.diff-text')].map(line => line.textContent))
      .toEqual(['first', 'middle', 'second', 'next', 'end'])
    expect(cards[0].querySelector('.diff-view')).toBe(firstPreview)
    expect([...firstPreview.querySelectorAll('.diff-text')].map(line => line.textContent)).toEqual(['old', 'first'])
    expect(view.container.querySelector('textarea, input, [contenteditable="true"]')).toBeNull()

    fireEvent.click(within(cards[0]).getByRole('button', { name: '收起记录' }))
    expect(within(cards[0]).getByRole('button', { name: '查看记录' })).toHaveAttribute('aria-expanded', 'false')
    expect(cards[1].querySelector('.diff-view')).toBe(secondPreview)
    fireEvent.click(within(cards[0]).getByRole('button', { name: '查看记录' }))
    expect([...cards[0].querySelectorAll('.diff-text')].map(line => line.textContent)).toEqual(['old', 'first'])
    expect(cards[1].querySelector('.diff-view')).toBe(secondPreview)
    expect(props.onScroll).not.toHaveBeenCalled()
  })

  it('keeps old cards and message DOM while busy, then inserts and moves the completed latest card without remounting', () => {
    const props = emptyTimelineProps()
    const first = [user(1), edit(2, '/project/old.ts', '+old'), answer(3)]
    const view = render(<ChatTimeline {...props} timeline={first} />)
    const oldCard = view.getByRole('region', { name: '本轮工具记录' })
    const oldUser = view.container.querySelector('.bubble-user')
    const oldReply = view.container.querySelector('.bubble-assistant')
    const next = [...first, user(4), edit(5, '/project/new.ts', '+new')]
    for (const activity of [{ busy: true, agentActivity: false }, { busy: false, agentActivity: true }]) {
      view.rerender(<ChatTimeline {...props} {...activity} timeline={next} />)
      expect(view.getAllByRole('region', { name: '本轮工具记录' })).toHaveLength(1)
      expect(view.getByRole('region', { name: '本轮工具记录' })).toBe(oldCard)
      expect(oldCard).toHaveTextContent('old.ts')
      expect(oldCard).not.toHaveTextContent('new.ts')
      expect(view.container.querySelector('.bubble-user')).toBe(oldUser)
      expect(view.container.querySelector('.bubble-assistant')).toBe(oldReply)
    }
    view.rerender(<ChatTimeline {...props} timeline={next} />)
    const cards = view.getAllByRole('region', { name: '本轮工具记录' })
    expect(cards).toHaveLength(2)
    expect(cards[0]).toBe(oldCard)
    expect(cards[1]).toHaveTextContent('new.ts')
    expect(cards[1].previousElementSibling).toHaveClass('tool-activity-item')
    view.rerender(<ChatTimeline {...props} timeline={[...next, answer(6)]} />)
    view.getAllByRole('region', { name: '本轮工具记录' }).forEach((card, index) => expect(card).toBe(cards[index]))
    expect(cards[1].previousElementSibling).toBe(view.container.querySelectorAll('.row-assistant')[1])
    expect(view.container.querySelector('.bubble-user')).toBe(oldUser)
    expect(view.container.querySelector('.bubble-assistant')).toBe(oldReply)
    expect(props.onScroll).not.toHaveBeenCalled()
  })

  it('does not attribute an orphaned page prefix to a later user or expose cards in read-only transcripts', () => {
    const props = emptyTimelineProps()
    props.timeline = [edit(1, '/project/orphan.ts', '+orphan'), answer(2), user(3), edit(4, '/project/owned.ts', '+owned')]
    const view = render(<ChatTimeline {...props} />)
    const cards = view.getAllByRole('region', { name: '本轮工具记录' })
    expect(cards).toHaveLength(1)
    expect(cards[0]).toHaveTextContent('owned.ts')
    expect(cards[0]).not.toHaveTextContent('orphan.ts')
    expect(view.container.querySelector('.tool-activity-item')?.nextElementSibling).toHaveClass('row-assistant')
    view.rerender(<ChatTimeline {...props} hasNewerHistory />)
    expect(view.queryByRole('region', { name: '本轮工具记录' })).not.toBeInTheDocument()
    view.rerender(<ChatTimeline {...props} readOnly />)
    expect(view.queryByRole('region', { name: '本轮工具记录' })).not.toBeInTheDocument()
    expect(view.container.querySelector('.modified-files-card')).toBeNull()
    expect(view.container.querySelector('.bubble-user')).toHaveTextContent('请求3')
  })
})

describe('ChatTimeline empty history state', () => {
  afterEach(cleanup)

  it('uses ordinary message and tool cards in read-only mode without mutation controls or tool media', () => {
    const props = emptyTimelineProps()
    props.timeline = [
      { kind: 'user', id: 1, entryId: 'unexpected-persistent-id', text: '子任务', historical: true },
      { kind: 'assistant', id: 2, text: '**子任务回复**', thinking: '子任务思考', streaming: false, historical: true },
      { kind: 'tool', id: 3, historical: true, tool: { id: 'child-tool', name: 'read',
        status: 'done', isError: false, path: 'file.ts', outputText: '工具输出',
        images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA', width: 1, height: 1, partIndex: 0 }] } }
    ]
    props.canFork = true
    props.canRevert = true
    props.onRevert = vi.fn()
    const view = render(<ChatTimeline {...props} readOnly agentActivity workingStatus={{ label: '子任务运行中' }} />)
    expect(view.container.querySelector('.chat-scroll .timeline .bubble-user')).toHaveTextContent('子任务')
    expect(view.container.querySelector('.bubble-assistant .markdown strong')).toHaveTextContent('子任务回复')
    expect(view.container.querySelector('.thinking pre')).toHaveTextContent('子任务思考')
    expect(view.getByRole('status')).toHaveTextContent('子任务运行中')
    expect(view.queryByRole('button', { name: '分叉' })).not.toBeInTheDocument()
    expect(view.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
    expect(view.queryByRole('button', { name: '撤销本轮' })).not.toBeInTheDocument()
    fireEvent.click(view.getByRole('button', { name: '展开工具调用（1次）' }))
    const toolHeader = view.getByRole('button', { name: '展开读取工具详情' })
    fireEvent.click(toolHeader)
    expect(view.container.querySelector('.tool-body .tool-output')).toHaveTextContent('工具输出')
    expect(view.container.querySelector('img, .tool-result-images, [data-entry-id]')).toBeNull()
    for (const callback of [props.onFork, props.onRevert]) {
      expect(callback).not.toHaveBeenCalled()
    }

    view.rerender(<ChatTimeline {...props} />)
    expect(view.getByRole('button', { name: '收起读取工具详情' })).toBe(toolHeader)
    expect(view.getByRole('img', { name: '工具结果预览 1' })).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(view.getByRole('button', { name: '分叉' })).toBeInTheDocument()
    expect(view.getByRole('button', { name: '撤销' })).toBeInTheDocument()
  })

  it('keeps the vertical scrollbar gutter through short or loading history windows', () => {
    const css = readFileSync(resolve('src/renderer/src/styles/chat.css'), 'utf8')
    const scrollRule = css.match(/\.chat-scroll\s*\{([^}]*)\}/)?.[1]
    expect(scrollRule).toContain('overflow-y: scroll;')
    expect(scrollRule).toContain('scrollbar-gutter: stable;')
    const view = render(<ChatTimeline {...emptyTimelineProps()} />)
    const main = view.getByRole('main')
    view.rerender(<ChatTimeline {...emptyTimelineProps()} timelineLoading historySelected timelineReady={false} />)
    expect(view.getByRole('main')).toBe(main)
  })

  it('keeps a hidden timeline mounted, inert and geometrically present with its own scroll ref', () => {
    const props = emptyTimelineProps()
    props.timeline = [{ kind: 'user', id: 1, text: '保留父会话' }]
    const surfaceRef = createRef<HTMLDivElement>()
    const view = render(<ChatTimeline {...props} scrollSurfaceRef={surfaceRef} className="parent-timeline" />)
    const main = props.scrollRef.current
    const surface = surfaceRef.current
    const bubble = view.container.querySelector('.bubble-user')
    view.rerender(<ChatTimeline {...props} scrollSurfaceRef={surfaceRef} className="parent-timeline" hidden />)
    expect(props.scrollRef.current).toBe(main)
    expect(surfaceRef.current).toBe(surface)
    expect(view.container.querySelector('.bubble-user')).toBe(bubble)
    expect(main).toHaveClass('chat-scroll', 'parent-timeline')
    expect(main).toHaveAttribute('aria-hidden', 'true')
    expect(main).toHaveAttribute('inert')
    expect(main).toHaveStyle({ visibility: 'hidden' })
    expect(main?.style.display).not.toBe('none')
    view.rerender(<ChatTimeline {...props} scrollSurfaceRef={surfaceRef} />)
    expect(props.scrollRef.current).toBe(main)
    expect(view.container.querySelector('.bubble-user')).toBe(bubble)
    expect(main).not.toHaveAttribute('aria-hidden')
    expect(main).not.toHaveAttribute('inert')
  })

  it('does not expose ordinary history reload actions for a read-only transcript', () => {
    const onReloadHistory = vi.fn()
    const view = render(<ChatTimeline {...emptyTimelineProps()} readOnly timelineError="读取失败" onReloadHistory={onReloadHistory} />)
    expect(view.getByRole('heading', { name: '会话历史未加载完成' })).toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
    expect(onReloadHistory).not.toHaveBeenCalled()
  })

  it('keeps a successful empty branch or new conversation ready despite other sessions', () => {
    const view = render(<ChatTimeline {...emptyTimelineProps()} />)
    expect(view.getByRole('heading', { name: 'Pion 已就绪' })).toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
  })

  it('shows selected but unaccepted history as unloaded even without a read diagnostic', () => {
    const onReloadHistory = vi.fn()
    const props = { ...emptyTimelineProps(), historySelected: true, timelineReady: false, onReloadHistory, starting: true }
    const view = render(<ChatTimeline {...props} />)
    expect(view.getByRole('heading', { name: '会话历史未加载完成' })).toBeInTheDocument()
    expect(view.queryByText('Pion 已就绪')).not.toBeInTheDocument()
    expect(view.queryByText('正在启动 agent…')).not.toBeInTheDocument()
    expect(view.getByText(/请重新加载会话历史/)).toBeInTheDocument()
    expect(onReloadHistory).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '重新加载' }))
    expect(onReloadHistory).toHaveBeenCalledTimes(1)
    view.rerender(<ChatTimeline {...props} timelineLoading />)
    expect(view.getByRole('heading', { name: '正在加载会话…' })).toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
    expect(onReloadHistory).toHaveBeenCalledTimes(1)
  })

  it('keeps an accepted empty selected branch ready without requesting a reload', () => {
    const onReloadHistory = vi.fn()
    const view = render(<ChatTimeline {...emptyTimelineProps()} historySelected timelineReady onReloadHistory={onReloadHistory} />)
    expect(view.getByRole('heading', { name: 'Pion 已就绪' })).toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
    expect(onReloadHistory).not.toHaveBeenCalled()
  })

  it('does not call an unselected new conversation unloaded merely because history has not been accepted', () => {
    const view = render(<ChatTimeline {...emptyTimelineProps()} timelineReady={false} />)
    expect(view.getByRole('heading', { name: 'Pion 已就绪' })).toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
  })

  it('retains legacy readiness when a caller selects history without supplying the acceptance flag', () => {
    const view = render(<ChatTimeline {...emptyTimelineProps()} historySelected />)
    expect(view.getByRole('heading', { name: 'Pion 已就绪' })).toBeInTheDocument()
  })

  it('keeps the existing working indicator instead of an unloaded empty state while busy', () => {
    const onReloadHistory = vi.fn()
    const view = render(<ChatTimeline {...emptyTimelineProps()} busy agentActivity historySelected timelineReady={false}
      workingStatus={{ label: '思考中...' }} onReloadHistory={onReloadHistory} />)
    expect(view.getByRole('status')).toHaveTextContent('思考中...')
    expect(view.queryByRole('heading')).not.toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
    expect(onReloadHistory).not.toHaveBeenCalled()
  })

  it('keeps partial live rows and activity visible even when a history read was not accepted', () => {
    const props = emptyTimelineProps()
    props.timeline = [{ kind: 'user', id: 2, text: '当前消息', live: true }]
    const view = render(<ChatTimeline {...props} busy agentActivity historySelected timelineReady={false}
      timelineError="会话历史未载入，请重新加载。" workingStatus={{ label: '组织回复中...' }} />)
    expect(view.container.querySelector('.row-user .bubble-content')).toHaveTextContent(/^当前消息$/)
    expect(view.getByRole('status')).toHaveTextContent('组织回复中...')
    expect(view.queryByText('会话历史未加载完成')).not.toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
  })

  it('does not disguise a history failure as readiness or backend startup', () => {
    const view = render(<ChatTimeline {...emptyTimelineProps()} starting timelineError="读取失败" />)
    expect(view.getByRole('heading', { name: '会话历史未加载完成' })).toBeInTheDocument()
    expect(view.queryByText('Pion 已就绪')).not.toBeInTheDocument()
    expect(view.getByText(/请重新选择该会话/)).toBeInTheDocument()
  })

  it('reloads only after an explicit click and hides the action while reading', () => {
    const onReloadHistory = vi.fn()
    const props = { ...emptyTimelineProps(), timelineError: '读取失败', onReloadHistory }
    const view = render(<ChatTimeline {...props} />)
    expect(onReloadHistory).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '重新加载' }))
    expect(onReloadHistory).toHaveBeenCalledTimes(1)
    view.rerender(<ChatTimeline {...props} timelineLoading />)
    expect(view.getByRole('heading', { name: '正在加载会话…' })).toBeInTheDocument()
    expect(view.queryByRole('button', { name: '重新加载' })).not.toBeInTheDocument()
    expect(onReloadHistory).toHaveBeenCalledTimes(1)
  })

  it('does not replace visible cached or live messages after a history read fails', () => {
    const props = emptyTimelineProps()
    props.timeline = [{ kind: 'user', id: 1, text: '保留消息', historical: true }]
    const view = render(<ChatTimeline {...props} historySelected timelineReady={false} timelineError="读取失败" />)
    expect(view.container.querySelector('.row-user .bubble-content')).toHaveTextContent(/^保留消息$/)
    expect(view.queryByText('会话历史未加载完成')).not.toBeInTheDocument()
  })
})
