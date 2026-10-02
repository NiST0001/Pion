// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useReducer } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionEntriesPage, WireEntry, WireMessage } from '../../src/shared/types'
import { useHistoryPaging } from '../../src/renderer/src/hooks/useHistoryPaging'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import { useAgentHistory } from '../../src/renderer/src/hooks/agent/useAgentHistory'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState, type Action, type TimelineItem } from '../../src/renderer/src/agent/types'
import { ToolCallItem } from '../../src/renderer/src/features/chat/ToolCallItem'
import { IMAGE_GENERATION_TOOL_NAME } from '../../src/shared/image-generation'
import { applyToolResult } from '../../src/renderer/src/agent/timeline'
import * as toolImages from '../../src/shared/tool-images'

const previewPart = {
  type: 'image', mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function findTool(items: TimelineItem[], toolCallId: string) {
  const row = items.find((item) => item.kind === 'tool' && item.tool.id === toolCallId)
  if (row?.kind !== 'tool') throw new Error(`Missing tool ${toolCallId}`)
  return row
}

function imageCallEntry(toolCallId: string, entryId = 'stored-call'): WireEntry {
  return { type: 'message', id: entryId, parentId: null, timestamp: '',
    message: { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId,
      name: IMAGE_GENERATION_TOOL_NAME, arguments: { path: 'images/argument.png' } }] } }
}

function imageResultEntry(toolCallId: string, text: string, image = true): WireEntry {
  return { type: 'message', id: `result-${toolCallId}`, parentId: null, timestamp: '',
    message: { role: 'toolResult', toolCallId, toolName: IMAGE_GENERATION_TOOL_NAME,
      content: image ? [{ type: 'text', text }, previewPart] : [{ type: 'text', text }], isError: false } }
}

function ToolHistoryRows({ items }: { items: TimelineItem[] }) {
  return <div>{items.map((item) => item.kind === 'tool'
    ? <ToolCallItem key={item.id} tool={item.tool} historical={item.historical} noReveal={item.noReveal} />
    : <div key={item.id}>{item.kind === 'compaction' ? item.summary : item.text}</div>)}</div>
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function scroller(initialHeight = 1000) {
  const element = document.createElement('div')
  let height = initialHeight, top = 0
  Object.defineProperties(element, {
    clientHeight: { value: 400 }, scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 400)) } }
  })
  return { element, grow: (value: number) => { height += value } }
}

it('requests the next page on outward wheel input even if scrollTop cannot change, and deduplicates pending requests', async () => {
  const { element } = scroller()
  element.scrollTop = 600
  let finish!: () => void
  const loadNewer = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  const h = renderHook(() => useHistoryPaging({ scrollRef: { current: element }, owner: 'a', timelineLength: 1, loadOlder: vi.fn(async () => undefined), loadNewer }))
  act(() => { h.result.current.onScroll(false, true) })
  expect(loadNewer).not.toHaveBeenCalled()
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80 }))
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80 }))
  expect(element.scrollTop).toBe(600)
  expect(loadNewer).toHaveBeenCalledTimes(1)
  await act(async () => { finish() })
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }))
  expect(loadNewer).toHaveBeenCalledTimes(2)
  await act(async () => { finish() })
})

it('requests newer history on an outward touch gesture at a hard boundary', () => {
  const { element } = scroller()
  element.scrollTop = 600
  const loadNewer = vi.fn(async () => undefined)
  renderHook(() => useHistoryPaging({ scrollRef: { current: element }, owner: 'a', timelineLength: 1, loadOlder: vi.fn(async () => undefined), loadNewer }))
  const start = new Event('touchstart')
  Object.defineProperty(start, 'touches', { value: [{ clientY: 200 }] })
  element.dispatchEvent(start)
  const move = new Event('touchmove')
  Object.defineProperty(move, 'touches', { value: [{ clientY: 100 }] })
  element.dispatchEvent(move)
  expect(loadNewer).toHaveBeenCalledWith({ viaScroll: true })
  expect(element.scrollTop).toBe(600)
})

it('does not page the outer conversation while a nested output can consume scrolling', () => {
  const { element } = scroller()
  element.scrollTop = 600
  const nested = document.createElement('div')
  nested.style.overflowY = 'auto'
  Object.defineProperties(nested, { clientHeight: { value: 100 }, scrollHeight: { value: 500 } })
  element.append(nested)
  const loadNewer = vi.fn(async () => undefined)
  renderHook(() => useHistoryPaging({ scrollRef: { current: element }, owner: 'a', timelineLength: 1, loadOlder: vi.fn(async () => undefined), loadNewer }))
  nested.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }))
  expect(loadNewer).not.toHaveBeenCalled()
  nested.scrollTop = 400
  nested.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }))
  expect(loadNewer).toHaveBeenCalledTimes(1)
})

it('keeps failed requests retryable without an automatic failure loop', async () => {
  const { element } = scroller()
  element.scrollTop = 600
  const loadNewer = vi.fn().mockRejectedValue(new Error('offline'))
  renderHook(() => useHistoryPaging({ scrollRef: { current: element }, owner: 'a', timelineLength: 1, loadOlder: vi.fn(async () => undefined), loadNewer }))
  await act(async () => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80 })) })
  expect(loadNewer).toHaveBeenCalledTimes(1)
  await act(async () => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80 })) })
  expect(loadNewer).toHaveBeenCalledTimes(2)
})

it('keeps an old viewport-fill completion from issuing requests in a replacement session', async () => {
  const { element } = scroller(400)
  const finish: Array<() => void> = []
  const loadOlder = vi.fn(() => new Promise<void>((resolve) => { finish.push(resolve) }))
  const loadNewer = vi.fn(async () => undefined)
  const options = { scrollRef: { current: element }, owner: 'a', timelineLength: 1, loadOlder, loadNewer }
  const h = renderHook((props) => useHistoryPaging(props), { initialProps: options })
  h.rerender({ ...options, owner: 'b' })
  expect(loadOlder).toHaveBeenCalledTimes(2)
  await act(async () => { finish[0]() })
  expect(loadNewer).not.toHaveBeenCalled()
  // Completion of A must not clear B's in-flight guard.
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80 }))
  expect(loadNewer).not.toHaveBeenCalled()
  await act(async () => { finish[1]() })
  expect(loadNewer).toHaveBeenCalledTimes(1)
})

it('walks from a jumped page through successive newer pages without auto-pinning, then follows only the real session tail', async () => {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const { element, grow } = scroller()
  const row = document.createElement('div')
  row.dataset.entryId = 'target'
  row.getBoundingClientRect = () => ({ top: 900 - element.scrollTop } as DOMRect)
  element.append(row)
  let remaining = 2
  let finish!: () => void
  const loadNewer = vi.fn(() => remaining > 0 ? new Promise<void>((resolve) => { finish = resolve }) : Promise.resolve())
  const first: TimelineItem = { kind: 'user', id: 1, text: 'target' }
  const options: Parameters<typeof useConversationNavigation>[0] = {
    scrollRef: { current: element }, timeline: [first], timelineMutation: 'replace', busy: false,
    sessionPath: '/a', historyJump: { entryId: 'target', nonce: 1 },
    hasNewerHistory: () => remaining > 0, loadOlder: vi.fn(async () => undefined), loadNewer
  }
  const h = renderHook((props) => useConversationNavigation(props), { initialProps: options })
  act(() => frames.splice(0).forEach((callback) => callback(0)))
  expect(element.scrollTop).toBe(600)
  let timeline = [first]
  for (let page = 0; page < 2; page++) {
    const oldBottom = element.scrollHeight - 400
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
    element.scrollTop = oldBottom
    act(() => h.result.current.handleTimelineScroll())
    expect(loadNewer).toHaveBeenCalledTimes(page + 1)
    await act(async () => {
      remaining--
      grow(800)
      timeline = [...timeline, { ...first, id: page + 2 }]
      h.rerender({ ...options, timeline, timelineMutation: 'history-append' })
      finish()
    })
    expect(element.scrollTop).toBe(oldBottom)
  }
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
  element.scrollTop = element.scrollHeight
  act(() => h.result.current.handleTimelineScroll())
  expect(element.scrollTop).toBe(2200)
  grow(200)
  h.rerender({ ...options, timeline: [...timeline, { ...first, id: 4 }], timelineMutation: 'append' })
  expect(element.scrollTop).toBe(2400)
})

it('reads session-tail availability from the current cursor, not a stale render snapshot', () => {
  const h = renderHook(() => useAgentHistory({ api: undefined, state: initialState, dispatch: vi.fn() }))
  expect(h.result.current.hasNewerHistory()).toBe(false)
  const cursor = {
    path: '/a', items: [], mode: initialState.mode, apiBefore: 0, apiAfter: 10,
    toolResults: [], complete: true, newerComplete: false, leafId: null, total: 20,
    loading: false, loadId: h.result.current.timelineLoadId.current
  }
  h.result.current.historyCursor.current = cursor
  expect(h.result.current.hasNewerHistory()).toBe(true)
  cursor.newerComplete = true
  expect(h.result.current.hasNewerHistory()).toBe(false)
  cursor.newerComplete = false
  h.result.current.timelineLoadId.current++
  expect(h.result.current.hasNewerHistory()).toBe(false)
})

it('reconciles a finalized live assistant into the ordered newer history page', async () => {
  const timestamp = 1_780_000_000_000
  const old: TimelineItem = { kind: 'user', id: 20, entryId: 'old', text: 'old page' }
  const live: TimelineItem = {
    kind: 'assistant', id: 21, messageTimestamp: timestamp,
    text: '', thinking: '', streaming: false, live: true, error: 'provider unavailable'
  }
  const dispatch = vi.fn<(action: Action) => void>()
  const api = {
    getEntriesPage: vi.fn().mockResolvedValue({
      entries: [
        {
          type: 'message', id: 'middle', parentId: 'old', timestamp: '2026-01-01T00:00:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'middle page' }] }
        },
        {
          type: 'message', id: 'persisted-error', parentId: 'middle', timestamp: '2026-01-01T00:00:01Z',
          message: {
            role: 'assistant', content: [], timestamp,
            stopReason: 'error', errorMessage: 'provider unavailable'
          }
        }
      ],
      toolResults: [], start: 2, end: 4, total: 4, leafId: 'persisted-error', mode: 'build'
    })
  }
  const state = { ...initialState, timeline: [old, live] }
  const h = renderHook(() => useAgentHistory({ api: api as never, state, dispatch }))
  act(() => {
    h.result.current.timelineOwnerPath.current = '/session.jsonl'
    h.result.current.historyCursor.current = {
      path: '/session.jsonl', items: [old, live], mode: 'build', apiBefore: 1, apiAfter: 2,
      toolResults: [], complete: false, newerComplete: false, leafId: 'old', total: 4,
      loading: false, loadId: h.result.current.timelineLoadId.current
    }
  })

  await act(async () => { await h.result.current.loadNewer() })

  const append = dispatch.mock.calls
    .map(([action]) => action)
    .find((action) => action.type === 'appendEntries')
  expect(append?.type).toBe('appendEntries')
  if (!append || append.type !== 'appendEntries') throw new Error('Missing history append')
  expect(append.items.map((item) => (
    item.kind === 'user' ? item.text : item.kind === 'assistant' ? item.error : undefined
  ))).toEqual(['middle page', 'provider unavailable'])
  expect(h.result.current.historyCursor.current?.items.map((item) => item.kind === 'tool' ? undefined : item.entryId))
    .toEqual(['old', 'middle', 'persisted-error'])
})

it('reconciles a deferred page against a final error queued before the page response', async () => {
  const timestamp = 1_780_000_000_100
  const old: TimelineItem = { kind: 'user', id: 30, entryId: 'old', text: 'old page' }
  const streaming: TimelineItem = {
    kind: 'assistant', id: 31, messageTimestamp: timestamp,
    text: '', thinking: '', streaming: true, live: true
  }
  const finalMessage = {
    role: 'assistant' as const, content: [], timestamp,
    stopReason: 'error', errorMessage: 'connection lost'
  }
  const page: SessionEntriesPage = {
    entries: [
      {
        type: 'message', id: 'middle', parentId: 'old', timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'middle page' }
      },
      {
        type: 'message', id: 'final-error', parentId: 'middle', timestamp: '2026-01-01T00:00:01Z',
        message: finalMessage
      }
    ],
    toolResults: [], start: 2, end: 4, total: 4, leafId: 'final-error', mode: 'build'
  }
  let finish!: (page: SessionEntriesPage) => void
  const pending = new Promise<SessionEntriesPage>((resolve) => { finish = resolve })
  const api = { getEntriesPage: vi.fn(() => pending) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState, timeline: [old, streaming] })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  act(() => {
    h.result.current.timelineOwnerPath.current = '/session.jsonl'
    h.result.current.historyCursor.current = {
      path: '/session.jsonl', items: [old, streaming], mode: 'build', apiBefore: 1, apiAfter: 2,
      toolResults: [], complete: false, newerComplete: false, leafId: 'old', total: 4,
      loading: false, loadId: h.result.current.timelineLoadId.current
    }
  })
  let loading!: Promise<void>
  act(() => { loading = h.result.current.loadNewer() })

  await act(async () => {
    // The cursor/render may still contain the streaming placeholder when the
    // page continuation runs; the reducer's action order must be authoritative.
    h.result.current.dispatch({ type: 'event', event: { type: 'message_end', message: finalMessage } })
    finish(page)
    await loading
  })

  const timeline = h.result.current.state.timeline
  expect(timeline.map((item) => item.kind === 'tool' ? undefined : item.entryId))
    .toEqual(['old', 'middle', 'final-error'])
  expect(timeline[2]).toMatchObject({
    id: streaming.id, streaming: false, error: 'connection lost', historyReconciled: true
  })
  expect(h.result.current.state.timelineMutation).toBe('history-append')
  expect(h.result.current.timelineCache.current.get('/session.jsonl')?.items).toEqual(timeline)
})

it.each([false, true])('reconciles deferred image-tool pages without remounting open details (live final first: %s)', async (liveFinalFirst) => {
  const toolCallId = 'image-race'
  const old: TimelineItem = { kind: 'user', id: 60, entryId: 'old-image-page', text: 'old page' }
  const running: TimelineItem = {
    kind: 'tool', id: 61, noReveal: true,
    tool: { id: toolCallId, name: IMAGE_GENERATION_TOOL_NAME, status: 'running', isError: false, live: true, outputText: '生成中' }
  }
  const tail: TimelineItem[] = [
    { kind: 'tool', id: 62, noReveal: true, tool: { id: 'tail-read', name: 'read', status: 'running', isError: false, live: true } },
    { kind: 'assistant', id: 63, text: 'streaming tail', thinking: '', streaming: true, live: true }
  ]
  const liveFinal = {
    role: 'toolResult' as const, toolCallId, toolName: IMAGE_GENERATION_TOOL_NAME, isError: false,
    content: [{ type: 'text', text: 'new live final' }, previewPart]
  }
  const pageResult = {
    ...liveFinal,
    isError: liveFinalFirst,
    content: liveFinalFirst ? [{ type: 'text', text: 'old page error' }] : [{ type: 'text', text: 'page final' }, previewPart]
  }
  const resultEntry = {
    type: 'message', id: 'stored-image-result', parentId: 'stored-image-call', timestamp: '2026-01-01T00:00:02Z',
    message: pageResult
  }
  const page: SessionEntriesPage = {
    entries: [
      {
        type: 'message', id: 'middle-image-page', parentId: 'old-image-page', timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'middle page' }
      },
      {
        type: 'message', id: 'stored-image-call', parentId: 'middle-image-page', timestamp: '2026-01-01T00:00:01Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: IMAGE_GENERATION_TOOL_NAME, arguments: {} }] }
      },
      resultEntry,
      {
        type: 'message', id: 'after-image-page', parentId: resultEntry.id, timestamp: '2026-01-01T00:00:03Z',
        message: { role: 'user', content: 'after page' }
      }
    ],
    toolResults: [resultEntry], start: 2, end: 6, total: 6, leafId: 'after-image-page', mode: 'build'
  }
  let finish!: (page: SessionEntriesPage) => void
  const pending = new Promise<SessionEntriesPage>((resolve) => { finish = resolve })
  const api = { getEntriesPage: vi.fn(() => pending) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState, timeline: [old, running, ...tail] })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  const view = render(<ToolHistoryRows items={h.result.current.state.timeline} />)
  fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
  const head = screen.getByRole('button', { name: '收起生图工具详情' })
  const body = view.container.querySelector('.tool-body')
  act(() => {
    h.result.current.timelineOwnerPath.current = '/image-session.jsonl'
    h.result.current.historyCursor.current = {
      path: '/image-session.jsonl', items: [old, running, ...tail], mode: 'build', apiBefore: 1, apiAfter: 2,
      toolResults: [], complete: false, newerComplete: false, leafId: old.entryId!, total: 6,
      loading: false, loadId: h.result.current.timelineLoadId.current
    }
  })
  let loading!: Promise<void>
  act(() => { loading = h.result.current.loadNewer() })
  await act(async () => {
    if (liveFinalFirst) {
      // Dispatch immediately before the deferred response, while the hook may
      // still hold a running snapshot. Reducer event order must win.
      h.result.current.dispatch({
        type: 'event', event: { type: 'tool_execution_end', toolCallId, toolName: IMAGE_GENERATION_TOOL_NAME, result: liveFinal, isError: false }
      })
    }
    finish(page)
    await loading
  })
  const timeline = h.result.current.state.timeline
  expect(timeline.map((item) => item.kind === 'tool' ? item.tool.id : item.kind === 'user' ? item.entryId : item.kind === 'assistant' ? item.text : item.summary))
    .toEqual(['old-image-page', 'middle-image-page', toolCallId, 'after-image-page', 'tail-read', 'streaming tail'])
  expect(timeline[2]).toMatchObject({
    id: running.id, historyReconciled: true, noReveal: true,
    tool: {
      status: 'done', isError: false, live: true,
      outputText: liveFinalFirst ? 'new live final' : 'page final',
      images: [{ partIndex: 1, width: 1, height: 1 }]
    }
  })
  expect(h.result.current.state.timelineMutation).toBe('history-append')
  expect(h.result.current.timelineCache.current.get('/image-session.jsonl')?.items).toEqual(timeline)
  view.rerender(<ToolHistoryRows items={timeline} />)
  expect(screen.getByRole('button', { name: '收起生图工具详情' })).toBe(head)
  expect(head).toHaveAttribute('aria-expanded', 'true')
  expect(view.container.querySelector('.tool-body')).toBe(body)
  const image = screen.getByRole('img', { name: '工具结果预览 1' })
  fireEvent.load(image)
  const images = findTool(timeline, toolCallId).tool.images
  await act(async () => {
    h.result.current.dispatch({ type: 'event', event: { type: 'message_end', message: liveFinalFirst ? liveFinal : pageResult } })
    h.result.current.dispatch({
      type: 'event', event: { type: 'tool_execution_update', toolCallId, toolName: IMAGE_GENERATION_TOOL_NAME, partialResult: { content: [{ type: 'text', text: 'late partial' }, previewPart] } }
    })
  })
  const promoted = h.result.current.state.timeline
  if (liveFinalFirst) {
    // Promoting execution -> message is a real state change, not a duplicate.
    expect(promoted).not.toBe(timeline)
    expect(findTool(promoted, toolCallId).tool.resultSource).toBe('message')
  } else {
    expect(promoted).toBe(timeline)
  }
  expect(h.result.current.state.timelineMutation).toBe(liveFinalFirst ? 'append' : 'history-append')
  expect(findTool(promoted, toolCallId).id).toBe(running.id)
  expect(findTool(promoted, toolCallId).tool.images).toBe(images)
  view.rerender(<ToolHistoryRows items={promoted} />)
  expect(screen.getByRole('img')).toBe(image)
  expect(screen.getByRole('button', { name: '收起生图工具详情' })).toBe(head)
  expect(view.container.querySelector('.tool-body')).toBe(body)
  expect(image.parentElement).toHaveAttribute('data-image-state', 'loaded')
  await act(async () => {
    h.result.current.dispatch({ type: 'event', event: { type: 'message_end', message: liveFinalFirst ? liveFinal : pageResult } })
  })
  expect(h.result.current.state.timeline).toBe(promoted)
})

it.each(['reload', 'jump'] as const)('preserves a final queued just before a deferred same-scope %s replacement, and acknowledges the reducer projection', async (operation) => {
  const path = '/replacement-image.jsonl'
  const toolCallId = 'replacement-image'
  const running: TimelineItem = {
    kind: 'tool', id: 201, noReveal: true, historyReconciled: true,
    tool: { id: toolCallId, name: IMAGE_GENERATION_TOOL_NAME, status: 'running', isError: false, live: true, outputText: 'partial' }
  }
  const offWindow: TimelineItem = { kind: 'user', id: 202, entryId: 'off-window', text: 'off window' }
  const landmark = { entryId: 'replacement-user', entryIndex: 5, ordinal: 1, snippet: '', timestamp: '' }
  const oldResult = imageResultEntry(toolCallId, 'stale persisted final', false)
  const page: SessionEntriesPage = {
    entries: [
      { type: 'message', id: landmark.entryId, parentId: null, timestamp: '', message: { role: 'user', content: 'selected page' } },
      imageCallEntry(toolCallId), oldResult
    ],
    toolResults: [oldResult], start: 5, end: 8, total: 20, leafId: oldResult.id, mode: 'build'
  }
  const final = imageResultEntry(toolCallId, 'latest live final').message!
  const pending = deferred<SessionEntriesPage>()
  const api = { getEntriesPage: vi.fn(() => pending.promise) }
  const seed = { ...initialState, timeline: [running, offWindow],
    historyIndex: { sessionPath: path, totalEntries: 20, landmarks: [landmark] } }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, seed)
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  const view = render(<ToolHistoryRows items={h.result.current.state.timeline} />)
  fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
  const head = screen.getByRole('button', { name: '收起生图工具详情' })
  const body = view.container.querySelector('.tool-body')
  act(() => {
    h.result.current.timelineOwnerPath.current = path
    h.result.current.timelineCache.current.set(path, {
      items: seed.timeline, mode: 'build', apiBefore: 9, apiAfter: 11,
      toolResults: [], complete: false, newerComplete: false, leafId: 'before-read', total: 19
    })
  })
  let loading!: Promise<void>
  act(() => { loading = operation === 'reload'
    ? h.result.current.reloadTimeline(path) : h.result.current.jumpToHistoryLandmark(landmark) })
  await act(async () => {
    // Neither the hook's render nor its cursor need have seen this terminal event.
    h.result.current.dispatch({ type: 'event', event: { type: 'message_end', message: final } })
    pending.resolve(page)
    await loading
  })
  const timeline = h.result.current.state.timeline
  const row = findTool(timeline, toolCallId)
  expect(timeline).toHaveLength(2)
  expect(row).toMatchObject({ id: running.id, noReveal: true, historyReconciled: true,
    tool: { status: 'done', resultReceived: true, resultSource: 'message', outputText: 'latest live final', images: [{ partIndex: 1 }] } })
  expect(h.result.current.state.timelineMutation).toBe('replace')
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.result.current.expectedTimeline.current).toBeNull()
  expect(h.result.current.historyCursor.current?.items).toBe(timeline)
  expect(h.result.current.timelineCache.current.get(path)?.items).toBe(timeline)
  view.rerender(<ToolHistoryRows items={timeline} />)
  expect(screen.getByRole('button', { name: '收起生图工具详情' })).toBe(head)
  expect(view.container.querySelector('.tool-body')).toBe(body)
  const image = screen.getByRole('img')
  fireEvent.load(image)
  const images = row.tool.images
  await act(async () => h.result.current.dispatch({ type: 'event', event: { type: 'message_end', message: final } }))
  expect(h.result.current.state.timeline).toBe(timeline)
  expect(findTool(h.result.current.state.timeline, toolCallId).tool.images).toBe(images)
  // Future live updates must still reach cache/cursor instead of being blocked
  // forever by the originally projected loadEntries array's stale identity.
  const next: WireMessage = { ...final, content: [{ type: 'text', text: 'transformed later final' }, previewPart] }
  await act(async () => h.result.current.dispatch({ type: 'event', event: { type: 'message_end', message: next } }))
  const updated = h.result.current.state.timeline
  expect(h.result.current.historyCursor.current?.items).toBe(updated)
  expect(h.result.current.timelineCache.current.get(path)?.items).toBe(updated)
  view.rerender(<ToolHistoryRows items={updated} />)
  expect(screen.getByRole('img')).toBe(image)
  expect(image.parentElement).toHaveAttribute('data-image-state', 'loaded')
  expect(screen.getByRole('button', { name: '收起生图工具详情' })).toBe(head)
})

it('does not reinstall a pre-request tool snapshot when same-leaf cache revalidation needs no replacement', async () => {
  const path = '/same-leaf.jsonl'
  const toolCallId = 'same-leaf-image'
  const row: TimelineItem = { kind: 'tool', id: 210,
    tool: { id: toolCallId, name: IMAGE_GENERATION_TOOL_NAME, status: 'running', isError: false, live: true } }
  const pending = deferred<SessionEntriesPage>()
  const api = { getEntriesPage: vi.fn(() => pending.promise) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState, timeline: [row] })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  const cached = { items: [row], mode: 'build' as const, apiBefore: 1, apiAfter: 3,
    toolResults: [], complete: false, newerComplete: false, leafId: 'unchanged-leaf', total: 4 }
  act(() => {
    h.result.current.timelineOwnerPath.current = path
    h.result.current.timelineCache.current.set(path, cached)
  })
  let loading!: Promise<void>
  act(() => { loading = h.result.current.reloadTimeline(path) })
  await act(async () => h.result.current.dispatch({ type: 'event', event: {
    type: 'message_end', message: imageResultEntry(toolCallId, 'final while revalidating').message!
  } }))
  const finalTimeline = h.result.current.state.timeline
  await act(async () => {
    pending.resolve({ entries: [], toolResults: [], start: 1, end: 3, total: 4,
      leafId: cached.leafId, mode: 'build' })
    await loading
  })
  expect(h.result.current.state.timeline).toBe(finalTimeline)
  expect(h.result.current.historyCursor.current?.items).toBe(finalTimeline)
  expect(h.result.current.timelineCache.current.get(path)?.items).toBe(finalTimeline)
})

it('finishes an overlapping older call without discarding its final or remounting its retained key', async () => {
  const path = '/older-images.jsonl'
  const toolCallId = 'older-missing-result'
  const missing: TimelineItem = { kind: 'tool', id: 220, historical: true, noReveal: true, historyReconciled: true,
    tool: { id: toolCallId, name: IMAGE_GENERATION_TOOL_NAME, status: 'done', isError: false } }
  const authoritative = imageResultEntry('older-completed', 'authoritative final').message!
  const completed: TimelineItem = { kind: 'tool', id: 221, historyReconciled: true,
    tool: applyToolResult({ ...missing.tool, id: 'older-completed' }, authoritative, false, 'message') }
  const after: TimelineItem = { kind: 'user', id: 222, entryId: 'after-retained', text: 'retained after' }
  const result = imageResultEntry(toolCallId, 'older page completion')
  const stale = imageResultEntry('older-completed', 'stale older completion', false)
  const page: SessionEntriesPage = {
    entries: [
      { type: 'message', id: 'older-user', parentId: null, timestamp: '', message: { role: 'user', content: 'older user' } },
      imageCallEntry(toolCallId), imageCallEntry('older-completed', 'completed-call'), result, stale
    ],
    toolResults: [result, stale], start: 1, end: 6, total: 20, leafId: 'later-leaf', mode: 'build'
  }
  const api = { getEntriesPage: vi.fn().mockResolvedValue(page) }
  const seed = { ...initialState, timeline: [missing, completed, after] }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, seed)
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  act(() => {
    h.result.current.timelineOwnerPath.current = path
    const cached = { items: seed.timeline, mode: 'build' as const, apiBefore: 6, apiAfter: 8,
      toolResults: [], complete: false, newerComplete: false, leafId: 'old-leaf', total: 20 }
    h.result.current.timelineCache.current.set(path, cached)
    h.result.current.historyCursor.current = { ...cached, path, loading: false, loadId: h.result.current.timelineLoadId.current }
  })
  await act(async () => { await h.result.current.loadOlder({ viaScroll: true }) })
  const timeline = h.result.current.state.timeline
  expect(timeline.map((item) => item.kind === 'tool' ? item.tool.id : item.kind === 'user' ? item.entryId : item.kind))
    .toEqual(['older-user', toolCallId, 'older-completed', after.entryId])
  expect(timeline[0]).toMatchObject({ noReveal: true, historical: true })
  expect(findTool(timeline, toolCallId)).toMatchObject({ id: missing.id, noReveal: true,
    tool: { status: 'done', resultSource: 'history', resultReceived: true, outputText: 'older page completion', images: [{ partIndex: 1 }] } })
  expect(findTool(timeline, 'older-completed')).toBe(completed)
  expect(h.result.current.state.timelineMutation).toBe('prepend')
  expect(h.result.current.historyCursor.current?.items).toBe(timeline)
  expect(h.result.current.timelineCache.current.get(path)?.items).toBe(timeline)
  expect(h.result.current.historyCursor.current?.loading).toBe(false)
  expect(api.getEntriesPage).toHaveBeenCalledTimes(1)
})

it('finishes a mounted call from newer result-only entries without creating or repositioning rows', async () => {
  const path = '/result-only-images.jsonl'
  const toolCallId = 'result-only-image'
  const running: TimelineItem = { kind: 'tool', id: 230, noReveal: true,
    tool: { id: toolCallId, name: IMAGE_GENERATION_TOOL_NAME, status: 'running', isError: false, live: true } }
  // A result alone cannot move a live call out of this retained page prefix.
  const after: TimelineItem = { kind: 'user', id: 231, entryId: 'after-prefix', text: 'after prefix' }
  const orphan = imageResultEntry('outside-window', 'orphan result')
  const result = imageResultEntry(toolCallId, 'result-only completion')
  const page: SessionEntriesPage = { entries: [result, orphan], toolResults: [],
    start: 5, end: 7, total: 7, leafId: orphan.id, mode: 'build' }
  const collect = vi.spyOn(toolImages, 'collectToolImages')
  const decode = vi.spyOn(globalThis, 'atob')
  const api = { getEntriesPage: vi.fn().mockResolvedValue(page) }
  const seed = { ...initialState, timeline: [running, after] }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, seed)
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  act(() => {
    h.result.current.timelineOwnerPath.current = path
    const cached = { items: seed.timeline, mode: 'build' as const, apiBefore: 3, apiAfter: 5,
      toolResults: [], complete: false, newerComplete: false, leafId: 'old-leaf', total: 7 }
    h.result.current.timelineCache.current.set(path, cached)
    h.result.current.historyCursor.current = { ...cached, path, loading: false, loadId: h.result.current.timelineLoadId.current }
  })
  await act(async () => { await h.result.current.loadNewer({ viaScroll: true }) })
  const timeline = h.result.current.state.timeline
  expect(timeline.map(({ id }) => id)).toEqual([running.id, after.id])
  expect(findTool(timeline, toolCallId)).toMatchObject({ noReveal: true,
    tool: { status: 'done', resultSource: 'history', resultReceived: true, outputText: 'result-only completion', images: [{ partIndex: 1 }] } })
  expect(findTool(timeline, toolCallId).historyReconciled).toBeUndefined()
  expect(h.result.current.state.timelineMutation).toBe('history-append')
  expect(h.result.current.timelineCache.current.get(path)?.items).toBe(timeline)
  expect(h.result.current.historyCursor.current?.items).toBe(timeline)
  expect(h.result.current.historyCursor.current?.apiAfter).toBe(7)
  expect(h.result.current.historyCursor.current?.loading).toBe(false)
  expect(h.result.current.hasNewerHistory()).toBe(false)
  expect(collect).toHaveBeenCalledTimes(1)
  expect(decode).toHaveBeenCalledTimes(1)
})

it.each(['reload', 'jump'] as const)('ignores a deferred %s result after an explicit same-path branch reset and does not revive the old final', async (operation) => {
  const path = '/branch-image.jsonl'
  const toolCallId = 'reused-branch-call'
  const oldResult = imageResultEntry(toolCallId, 'old branch result')
  const oldRow: TimelineItem = { kind: 'tool', id: 240,
    tool: applyToolResult({ id: toolCallId, name: IMAGE_GENERATION_TOOL_NAME, status: 'running', isError: false }, oldResult.message, false) }
  const landmark = { entryId: 'branch-user', entryIndex: 4, ordinal: 1, snippet: '', timestamp: '' }
  const stale: SessionEntriesPage = { entries: [imageCallEntry(toolCallId), oldResult], toolResults: [oldResult],
    start: 2, end: 4, total: 9, leafId: oldResult.id, mode: 'build' }
  const newPage: SessionEntriesPage = { entries: [imageCallEntry(toolCallId, 'new-branch-call')], toolResults: [],
    start: 0, end: 1, total: 1, leafId: 'new-branch-call', mode: 'build' }
  const pending = deferred<SessionEntriesPage>()
  const api = { getEntriesPage: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(newPage) }
  const seed = { ...initialState, timeline: [oldRow],
    historyIndex: { sessionPath: path, totalEntries: 9, landmarks: [landmark] } }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, seed)
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  h.result.current.timelineOwnerPath.current = path
  let loading!: Promise<void>
  act(() => { loading = operation === 'reload'
    ? h.result.current.reloadTimeline(path) : h.result.current.jumpToHistoryLandmark(landmark) })
  act(() => {
    h.result.current.invalidateSelection()
    h.result.current.timelineCache.current.delete(path)
    h.result.current.dispatch({ type: 'clearTimeline' })
  })
  await act(async () => { await h.result.current.reloadTimeline(path) })
  const timeline = h.result.current.state.timeline
  expect(findTool(timeline, toolCallId).tool.resultReceived).toBeUndefined()
  expect(findTool(timeline, toolCallId).tool.images).toBeUndefined()
  expect(findTool(timeline, toolCallId).id).not.toBe(oldRow.id)
  await act(async () => { pending.resolve(stale); await loading })
  expect(h.result.current.state.timeline).toBe(timeline)
  expect(h.result.current.timelineCache.current.get(path)?.items).toBe(timeline)
  expect(h.result.current.expectedTimeline.current).toBeNull()
})

it.each(['reload', 'jump'] as const)('keeps a delayed %s snapshot and reused call IDs isolated from a real session switch', async (operation) => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => callback(0))
    return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const oldPath = '/scope-a.jsonl', newPath = '/scope-b.jsonl'
  const toolCallId = 'same-id-in-different-session'
  const result = imageResultEntry(toolCallId, 'session A final')
  const row: TimelineItem = { kind: 'tool', id: 250,
    tool: applyToolResult({ id: toolCallId, name: IMAGE_GENERATION_TOOL_NAME, status: 'running', isError: false }, result.message, false) }
  const landmark = { entryId: 'scope-user', entryIndex: 3, ordinal: 1, snippet: '', timestamp: '' }
  const pending = deferred<SessionEntriesPage>()
  const oldPage: SessionEntriesPage = { entries: [imageCallEntry(toolCallId), result], toolResults: [result],
    start: 1, end: 3, total: 10, leafId: result.id, mode: 'build' }
  const newPage: SessionEntriesPage = { entries: [imageCallEntry(toolCallId, 'b-call')], toolResults: [],
    start: 0, end: 1, total: 1, leafId: 'b-call', mode: 'build' }
  const api = {
    getEntriesPage: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(newPage),
    switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
    getHistoryIndex: vi.fn().mockResolvedValue({ sessionPath: newPath, totalEntries: 1, leafId: 'b-call', landmarks: [] })
  }
  const seed = { ...initialState, timeline: [row],
    historyIndex: { sessionPath: oldPath, totalEntries: 10, landmarks: [landmark] } }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, seed)
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state }
  })
  h.result.current.timelineOwnerPath.current = oldPath
  let loading!: Promise<void>
  act(() => { loading = operation === 'reload'
    ? h.result.current.reloadTimeline(oldPath) : h.result.current.jumpToHistoryLandmark(landmark) })
  await act(async () => { expect(await h.result.current.switchSession(newPath)).toEqual({ cancelled: false }) })
  const timeline = h.result.current.state.timeline
  expect(h.result.current.timelineOwnerPath.current).toBe(newPath)
  expect(findTool(timeline, toolCallId).tool.resultReceived).toBeUndefined()
  expect(findTool(timeline, toolCallId).tool.images).toBeUndefined()
  expect(findTool(timeline, toolCallId).id).not.toBe(row.id)
  await act(async () => { pending.resolve(oldPage); await loading })
  expect(h.result.current.state.timeline).toBe(timeline)
  expect(h.result.current.timelineCache.current.get(newPath)?.items).toBe(timeline)
  expect(h.result.current.expectedTimeline.current).toBeNull()
})

it('marks history-page append separately from live append in the reducer', () => {
  const state = reducer(initialState, { type: 'appendEntries', items: [{ kind: 'user', id: 1, text: 'page' }] })
  expect(state.timelineMutation).toBe('history-append')
})

it('replaces a pinned live row before appending its ordered persisted page', () => {
  const live: TimelineItem = {
    kind: 'assistant', id: 2, messageTimestamp: 1_780_000_000_000,
    text: 'final', thinking: '', streaming: false, live: true
  }
  const stillLive: TimelineItem = {
    kind: 'assistant', id: 5, text: 'streaming', thinking: '', streaming: true, live: true
  }
  const state = reducer({
    ...initialState,
    timeline: [{ kind: 'user', id: 1, text: 'old' }, stillLive, live]
  }, {
    type: 'appendEntries',
    items: [
      { kind: 'user', id: 3, text: 'middle' },
      {
        kind: 'assistant', id: 4, entryId: 'final', messageTimestamp: 1_780_000_000_000,
        text: 'final', thinking: '', streaming: false
      }
    ]
  })

  expect(state.timeline.map((item) => item.id)).toEqual([1, 3, live.id, stillLive.id])
  expect(state.timeline[2]).toMatchObject({ entryId: 'final', historyReconciled: true })
  expect(state.timelineMutation).toBe('history-append')
})
