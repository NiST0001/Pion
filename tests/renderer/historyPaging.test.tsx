// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useReducer, type Dispatch } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionEntriesPage, SessionMeta, WireEntry, WireMessage } from '../../src/shared/types'
import { useHistoryPaging } from '../../src/renderer/src/hooks/useHistoryPaging'
import { useConversationNavigation } from '../../src/renderer/src/hooks/useConversationNavigation'
import { useAgentHistory } from '../../src/renderer/src/hooks/agent/useAgentHistory'
import { useAgentSubscriptions } from '../../src/renderer/src/hooks/agent/useAgentSubscriptions'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState, type Action, type AgentState, type TimelineItem } from '../../src/renderer/src/agent/types'
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

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

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

it('rejects a replacement captured before a queued selection clear but accepts the new selected scope', () => {
  const oldPath = '/queued-old.jsonl', newPath = '/queued-new.jsonl'
  const oldRow: TimelineItem = { kind: 'assistant', id: 880, text: 'old draft', thinking: '', streaming: true }
  const newRow: TimelineItem = { kind: 'user', id: 881, text: 'new conversation' }
  const oldState = { ...initialState, timeline: [oldRow],
    session: { sessionId: 'old-id', sessionFile: oldPath } as NonNullable<typeof initialState.session> }
  const cleared = reducer(oldState, { type: 'clearTimeline', sessionPath: newPath })
  const stale = reducer(cleared, { type: 'loadEntries', items: [oldRow],
    preserveToolState: { revision: oldState.timelineScopeRevision, sessionPath: oldPath } })
  expect(stale).toBe(cleared)
  // The old SDK snapshot can remain visible during startup; the queued clear
  // is the selected transcript boundary, not that stale session metadata.
  const loaded = reducer(cleared, { type: 'loadEntries', items: [newRow],
    preserveToolState: { revision: cleared.timelineScopeRevision, sessionPath: newPath } })
  expect(loaded.timeline).toEqual([newRow])
})

it('marks history-page append separately from live append in the reducer', () => {
  const state = reducer(initialState, { type: 'appendEntries', items: [{ kind: 'user', id: 1, text: 'page' }] })
  expect(state.timelineMutation).toBe('history-append')
})

const switchPaths = { a: '/selected-a.jsonl', b: '/selected-b.jsonl', c: '/selected-c.jsonl' }
const switchCwds = { a: '/worktree-a', b: '/worktree-b', c: '/worktree-c' }

function switchHistoryPage(label: string): SessionEntriesPage {
  return { entries: [
    { type: 'message', id: `${label}-user`, parentId: null, timestamp: '',
      message: { role: 'user', content: `${label} question` } },
    { type: 'message', id: `${label}-assistant`, parentId: `${label}-user`, timestamp: '',
      message: { role: 'assistant', content: `${label} answer` } }
  ], toolResults: [], start: 0, end: 2, total: 2, leafId: `${label}-assistant`, mode: 'build' }
}

function switchHistoryFixture(source: 'explicit' | 'sidebar' | 'cache' | 'unknown' = 'explicit') {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback); return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const ack = deferred<{ cancelled: boolean }>(), page = deferred<SessionEntriesPage>()
  const api = {
    switchSession: vi.fn(() => ack.promise), getEntriesPage: vi.fn(() => page.promise),
    // A cold selected backend can have no SDK snapshot yet. It is not an
    // authoritative empty transcript and must not gate its first disk page.
    getState: vi.fn().mockResolvedValue(null), getHistoryIndex: vi.fn().mockResolvedValue(null),
    onEvent: vi.fn(() => () => undefined)
  }
  const sessionMeta = (key: keyof typeof switchPaths): SessionMeta => ({
    id: key, path: switchPaths[key], projectCwd: switchCwds[key], timestamp: '',
    mtime: 0, preview: '', messageCount: 2
  })
  const seed: AgentState = { ...initialState,
    status: { phase: 'running', cwd: switchCwds.a },
    session: { sessionId: 'sdk-a', sessionFile: switchPaths.a, messageCount: 2, isStreaming: false },
    sessionsByProject: {
      [switchCwds.a]: [sessionMeta('a')],
      ...(source === 'cache' || source === 'unknown' ? {} : { [switchCwds.b]: [sessionMeta('b')] }),
      [switchCwds.c]: [sessionMeta('c')]
    },
    timeline: [{ kind: 'user', id: 3001, text: 'A already visible' }], timelineReady: true
  }
  const actions: Action[] = []
  const h = renderHook(() => {
    const [state, dispatch] = useReducer((previous: AgentState, action: Action) => {
      actions.push(action)
      return reducer(previous, action)
    }, seed)
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  if (source === 'cache' || source === 'explicit') h.result.current.timelineCache.current.set(switchPaths.b, {
    // Explicit caller/sidebar knowledge outranks an obsolete cache cwd.
    // A cache alone cannot establish a different selected worktree.
    cwd: source === 'cache' ? switchCwds.b : '/obsolete-cache-worktree',
    items: [], mode: 'build', apiBefore: 0, apiAfter: 2, total: 2,
    toolResults: [], complete: true, newerComplete: true, leafId: 'B-assistant'
  })
  const paint = async (): Promise<void> => {
    for (let frame = 0; frame < 2; frame++) await act(async () => {
      frames.splice(0).forEach((callback) => callback(0))
    })
  }
  return { ...h, api, ack, page, paint, actions }
}

it.each(['explicit', 'sidebar'] as const)('registers the selected cwd from %s before a cold page and accepts later same-cwd backend metadata', async (source) => {
  const h = switchHistoryFixture(source)
  let switching!: Promise<{ cancelled: boolean }>
  act(() => { switching = h.result.current.switchSession(switchPaths.b, source === 'explicit' ? switchCwds.b : undefined) })
  expect(h.result.current.state.status.cwd).toBe(switchCwds.b)
  expect(h.result.current.state.timelineReady).toBe(false)
  expect(h.result.current.state.timelineLoading).toBe(true)
  await h.paint()
  await act(async () => { h.ack.resolve({ cancelled: false }) })
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(1)
  expect(h.api.getEntriesPage).toHaveBeenCalledWith(undefined, expect.any(Number), switchPaths.b)
  const selected = h.result.current.selectionRef.current
  expect(selected).toMatchObject({ ownerPath: switchPaths.b, cwd: switchCwds.b })
  expect(selected.sessionId).toBeUndefined()
  expect(selected.sessionPath).toBeUndefined()
  for (const phase of ['ready', 'starting', 'running'] as const) {
    act(() => h.result.current.dispatch({ type: 'status', status: { phase, cwd: switchCwds.b } }))
    expect(h.result.current.selectionRef.current).toBe(selected)
  }
  act(() => h.result.current.dispatch({ type: 'session', session: {
    sessionId: 'late-sdk-b', sessionFile: switchPaths.b, messageCount: 2, isStreaming: false
  } }))
  expect(h.result.current.selectionRef.current).toBe(selected)
  await act(async () => { h.page.resolve(switchHistoryPage('B')) })
  await h.paint()
  await act(async () => { expect(await switching).toEqual({ cancelled: false }) })
  expect(h.result.current.state.timeline).toEqual([
    expect.objectContaining({ kind: 'user', text: 'B question' }),
    expect.objectContaining({ kind: 'assistant', text: 'B answer' })
  ])
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.result.current.state.timelineError).toBeUndefined()
  expect(h.result.current.expectedTimeline.current).toBeNull()
  expect(h.result.current.state.timelineReady).toBe(true)
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(1)
  expect(h.api.getState).toHaveBeenCalledTimes(1)
  expect(h.actions.find((action) => action.type === 'loadEntries')).toMatchObject({
    preserveToolState: { cwd: switchCwds.b, sessionPath: switchPaths.b }
  })
})

it('accepts STATUS(B) followed by a nonempty page in the same React batch without capturing A cwd', async () => {
  const h = switchHistoryFixture()
  // Deliberately finish both paint barriers as microtasks inside one act: the
  // hook must capture queued selection intent even before React renders it.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => callback(0)); return 1
  })
  const request = deferred<void>()
  let capturedSelection: { ownerPath?: string; cwd?: string } | undefined
  h.api.getEntriesPage.mockImplementation(() => {
    capturedSelection = { ...h.result.current.selectionRef.current }
    request.resolve()
    return h.page.promise
  })
  await act(async () => {
    const switching = h.result.current.switchSession(switchPaths.b, switchCwds.b)
    h.ack.resolve({ cancelled: false })
    await request.promise
    h.result.current.dispatch({ type: 'status', status: { phase: 'ready', cwd: switchCwds.b } })
    h.result.current.dispatch({ type: 'session', session: {
      sessionId: 'batch-sdk-b', sessionFile: switchPaths.b, messageCount: 2, isStreaming: false
    } })
    h.page.resolve(switchHistoryPage('B'))
    expect(await switching).toEqual({ cancelled: false })
  })
  expect(capturedSelection).toMatchObject({ ownerPath: switchPaths.b, cwd: switchCwds.b })
  expect(h.result.current.state.timeline, JSON.stringify({
    captured: capturedSelection,
    selected: h.result.current.selectionRef.current,
    cwd: h.result.current.state.status.cwd,
    error: h.result.current.state.timelineError,
    actions: h.actions.map((action) => ({ type: action.type,
      ...('preserveToolState' in action ? { scope: action.preserveToolState } : {}) }))
  })).toHaveLength(2)
  expect(h.result.current.state.timelineReady).toBe(true)
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.result.current.state.timelineError).toBeUndefined()
  expect(h.result.current.selectionRef.current).toMatchObject({ ownerPath: switchPaths.b, cwd: switchCwds.b })
  expect(h.actions.find((action) => action.type === 'loadEntries')).toMatchObject({
    preserveToolState: { cwd: switchCwds.b, sessionPath: switchPaths.b }
  })
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(1)
})

it.each(['a', 'c'] as const)('keeps a late B page from replacing the selected %s after a cross-worktree switch', async (key) => {
  const h = switchHistoryFixture()
  let first!: Promise<{ cancelled: boolean }>
  act(() => { first = h.result.current.switchSession(switchPaths.b, switchCwds.b) })
  await h.paint()
  await act(async () => { h.ack.resolve({ cancelled: false }) })
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(1)
  h.api.switchSession.mockResolvedValue({ cancelled: false })
  h.api.getEntriesPage.mockResolvedValue(switchHistoryPage(key.toUpperCase()))
  // Simulate the SDK gap while another explicit selection is made. The
  // next owner/cwd, not a filled identity for B, invalidates the old reader.
  act(() => h.result.current.dispatch({ type: 'session', session: null }))
  let next!: Promise<{ cancelled: boolean }>
  act(() => { next = h.result.current.switchSession(switchPaths[key], switchCwds[key]) })
  await h.paint()
  await h.paint()
  await act(async () => { expect(await next).toEqual({ cancelled: false }) })
  const timeline = h.result.current.state.timeline
  expect(timeline).toEqual([
    expect.objectContaining({ text: `${key.toUpperCase()} question` }),
    expect.objectContaining({ text: `${key.toUpperCase()} answer` })
  ])
  await act(async () => { h.page.resolve(switchHistoryPage('late B')) })
  await h.paint()
  await act(async () => { expect(await first).toEqual({ cancelled: true }) })
  expect(h.result.current.state.timeline).toBe(timeline)
  expect(h.result.current.state.status.cwd).toBe(switchCwds[key])
  expect(h.result.current.selectionRef.current.ownerPath).toBe(switchPaths[key])
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(2)
})

it.each(['cwd', 'path', 'identity'] as const)('still rejects a late B page after a genuine external %s change', async (change) => {
  const h = switchHistoryFixture()
  let switching!: Promise<{ cancelled: boolean }>
  act(() => { switching = h.result.current.switchSession(switchPaths.b, switchCwds.b) })
  await h.paint()
  await act(async () => { h.ack.resolve({ cancelled: false }) })
  act(() => h.result.current.dispatch({ type: 'session', session: {
    sessionId: 'sdk-b', sessionFile: switchPaths.b, messageCount: 2, isStreaming: false
  } }))
  const selected = h.result.current.selectionRef.current
  act(() => {
    if (change === 'cwd') h.result.current.dispatch({ type: 'status', status: { phase: 'running', cwd: switchCwds.c } })
    else h.result.current.dispatch({ type: 'session', session: {
      sessionId: change === 'identity' ? 'replacement-sdk-b' : 'sdk-c',
      sessionFile: change === 'path' ? switchPaths.c : switchPaths.b, messageCount: 2, isStreaming: false
    } })
  })
  expect(h.result.current.selectionRef.current.generation).toBeGreaterThan(selected.generation)
  await act(async () => { h.page.resolve(switchHistoryPage('obsolete B')) })
  await h.paint()
  await act(async () => { await switching })
  expect(h.result.current.state.timeline).toEqual([])
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(1)
})

it.each(['committed target', 'queued target'] as const)('restores A status and bounded cached output after a cancelled cross-cwd switch with %s', async (timing) => {
  const h = switchHistoryFixture()
  const draft: TimelineItem = { kind: 'assistant', id: 3002, live: true,
    text: 'A unfinished draft', thinking: '', streaming: true }
  act(() => {
    h.result.current.dispatch({ type: 'loadEntries', items: [...h.result.current.state.timeline, draft] })
    h.result.current.dispatch({ type: 'event', event: { type: 'agent_start',
      _pionLive: { backendId: 'backend-a', revision: 1, cwd: switchCwds.a, sessionPath: switchPaths.a } } })
  })
  const cached = h.result.current.timelineCache.current.get(switchPaths.a)!
  if (timing === 'queued target') vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => callback(0)); return 1
  })
  let switching!: Promise<{ cancelled: boolean }>
  if (timing === 'committed target') {
    act(() => { switching = h.result.current.switchSession(switchPaths.b, switchCwds.b) })
    expect(h.result.current.state.status.cwd).toBe(switchCwds.b)
    await h.paint()
    await act(async () => { h.ack.resolve({ cancelled: true }); expect(await switching).toEqual({ cancelled: true }) })
  } else await act(async () => {
    switching = h.result.current.switchSession(switchPaths.b, switchCwds.b)
    h.ack.resolve({ cancelled: true })
    expect(await switching).toEqual({ cancelled: true })
  })
  expect(h.result.current.state.status).toEqual({ phase: 'running', cwd: switchCwds.a })
  expect(h.result.current.selectionRef.current).toMatchObject({ ownerPath: switchPaths.a, cwd: switchCwds.a })
  expect(h.result.current.state.timeline).toEqual([
    expect.objectContaining({ text: 'A already visible', historical: true, noReveal: false }),
    expect.objectContaining({ text: 'A unfinished draft', streaming: true, historical: true, noReveal: false })
  ])
  expect(cached.items[1]).toBe(draft)
  expect(h.result.current.expectedTimeline.current).toBeNull()
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.actions.filter((action) => action.type === 'loadEntries').at(-1)).toMatchObject({
    preserveToolState: { cwd: switchCwds.a, sessionPath: switchPaths.a }
  })
  expect(h.api.getEntriesPage).not.toHaveBeenCalled()
})

it.each(['unknown', 'cache'] as const)('does not guess an unknown target cwd from %s evidence', async (source) => {
  const h = switchHistoryFixture(source)
  let switching!: Promise<{ cancelled: boolean }>
  act(() => { switching = h.result.current.switchSession(switchPaths.b) })
  await h.paint()
  await act(async () => { h.ack.resolve({ cancelled: false }) })
  const selected = h.result.current.selectionRef.current
  // Legacy callers with no local directory evidence cannot claim this is the
  // same worktree. A real later cwd change must keep the old read obsolete.
  act(() => h.result.current.dispatch({ type: 'status', status: { phase: 'ready', cwd: switchCwds.b } }))
  expect(h.result.current.selectionRef.current.generation).toBeGreaterThan(selected.generation)
  await act(async () => { h.page.resolve(switchHistoryPage('unknown old scope')) })
  await h.paint()
  await act(async () => { await switching })
  expect(h.result.current.state.status.cwd).toBe(switchCwds.b)
  expect(h.result.current.state.timeline).toEqual([])
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.api.getEntriesPage).toHaveBeenCalledTimes(1)
})

it('rearms cached scroll-page rows only on a real A → B → A selection without mutating the old cache', async () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => callback(0)); return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const a = '/reveal-cache-a', b = '/reveal-cache-b'
  const tool = { id: 'cached-read', name: 'read', status: 'done' as const, isError: false, outputText: 'cached result' }
  const rows: TimelineItem[] = [
    { kind: 'user', id: 890, text: 'cached question', historical: true, noReveal: true },
    { kind: 'assistant', id: 891, text: 'cached answer', thinking: '', streaming: false, historical: true, noReveal: true },
    { kind: 'tool', id: 892, tool, historical: true, noReveal: true }
  ]
  const session = (path: string) => ({ sessionId: path, sessionFile: path,
    isStreaming: false, isCompacting: false }) as NonNullable<typeof initialState.session>
  const empty: SessionEntriesPage = { entries: [], toolResults: [], start: 0,
    end: 0, total: 0, leafId: null, mode: 'build' }
  let dispatch!: Dispatch<Action>
  const api = {
    onEvent: vi.fn(() => () => undefined),
    getEntriesPage: vi.fn().mockResolvedValue(empty),
    getHistoryIndex: vi.fn().mockResolvedValue(null),
    switchSession: vi.fn(async (path: string) => {
      dispatch({ type: 'session', session: session(path) }); return { cancelled: false }
    })
  }
  const h = renderHook(() => {
    const [state, nextDispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd: '/project' }, session: session(a), timeline: rows })
    dispatch = nextDispatch
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state }
  })
  const originalCache = h.result.current.timelineCache.current.get(a)!
  expect(originalCache.items).toBe(rows)
  // Revalidating the currently selected page is not another selection: its
  // scroll-inserted rows still opt out of reveal and keep their exact identity.
  await act(async () => { await h.result.current.reloadTimeline(a) })
  expect(h.result.current.state.timeline).toBe(rows)
  expect(rows.every((row) => row.noReveal === true)).toBe(true)
  await act(async () => { await h.result.current.switchSession(b) })
  await act(async () => { await h.result.current.switchSession(a) })
  const restored = h.result.current.state.timeline
  expect(restored.map((row) => ({ id: row.id, historical: row.historical, noReveal: row.noReveal })))
    .toEqual(rows.map((row) => ({ id: row.id, historical: true, noReveal: false })))
  expect(restored[0]).not.toBe(rows[0])
  expect(findTool(restored, tool.id).tool).toBe(tool)
  expect(originalCache.items).toBe(rows)
  expect(rows.every((row) => row.noReveal === true)).toBe(true)
  // Same-scope cache revalidation must not clone/rearm the mounted transcript.
  await act(async () => { await h.result.current.reloadTimeline(a) })
  expect(h.result.current.state.timeline).toBe(restored)
})

it('keeps cached reveal markers when the selected live STATE arrives before the cached restore', async () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => callback(0)); return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const a = '/early-state-a', b = '/early-state-b', cwd = '/project'
  const pending = deferred<SessionEntriesPage>()
  const cachedRow: TimelineItem = { kind: 'assistant', id: 895, text: 'cached final',
    thinking: '', streaming: false, live: true, messageTimestamp: 100, historical: true, noReveal: true }
  const api = {
    onEvent: vi.fn(() => () => undefined),
    switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
    getEntriesPage: vi.fn().mockReturnValue(pending.promise),
    getHistoryIndex: vi.fn().mockResolvedValue(null)
  }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd }, runningSessionPaths: [a],
      session: { sessionId: b, sessionFile: b } as NonNullable<typeof initialState.session> })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  h.result.current.timelineCache.current.set(a, { cwd, items: [cachedRow], mode: 'build',
    apiBefore: 0, apiAfter: 0, toolResults: [], complete: true, newerComplete: true,
    leafId: null, total: 0, liveSessionBackendId: 'early-backend' })
  let switching!: Promise<unknown>
  act(() => {
    switching = h.result.current.switchSession(a)
    h.result.current.dispatch({ type: 'session', session: {
      sessionId: a, sessionFile: a, messageCount: 1, isStreaming: false, liveState: {
        backendId: 'early-backend', revision: 1, cwd, sessionPath: a, events: [
          { type: 'message_start', message: { role: 'assistant', timestamp: 100, content: [] } },
          { type: 'message_end', message: { role: 'assistant', timestamp: 100,
            content: [{ type: 'text', text: 'fresh final' }] } }
        ]
      }
    } as NonNullable<typeof initialState.session> })
  })
  await act(async () => {
    for (let tick = 0; tick < 12; tick++) await Promise.resolve()
  })
  expect(h.result.current.state.timeline).toHaveLength(1)
  expect(h.result.current.state.timeline[0]).toMatchObject({ text: 'fresh final', historical: true, noReveal: false })
  expect(cachedRow).toMatchObject({ text: 'cached final', historical: true, noReveal: true })
  await act(async () => {
    pending.resolve({ entries: [], toolResults: [], start: 0, end: 0, total: 0, leafId: null, mode: 'build' })
    await switching
  })
  expect(h.result.current.state.timeline[0]).toMatchObject({ text: 'fresh final', historical: true, noReveal: false })
})

it.each(['running paths', 'backend identity', 'metadata first'] as const)('seeds a fresh running session cache and keeps its draft on the first A → B → A revisit with empty JSONL pages using %s', async (proof) => {
  let beforeCachedPaint: (() => void) | undefined
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => {
      const publish = beforeCachedPaint
      beforeCachedPaint = undefined
      publish?.()
      callback(0)
    })
    return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const a = '/fresh-running-a.jsonl', b = '/fresh-running-b.jsonl'
  const draft: TimelineItem = { kind: 'assistant', id: 901, live: true,
    messageTimestamp: 100, text: 'first token', thinking: '', streaming: true }
  const tool: Extract<TimelineItem, { kind: 'tool' }> = { kind: 'tool', id: 902, tool: { id: 'cached-running-tool', name: 'read',
    path: 'file.ts', outputText: 'running progress label', status: 'running',
    isError: false, live: true } }
  const rows = proof !== 'running paths' ? [draft, tool] : [draft]
  const session = (path: string) => ({ sessionId: path, sessionFile: path,
    isStreaming: path === a, isCompacting: false }) as NonNullable<typeof initialState.session>
  let dispatch!: Dispatch<Action>
  const empty: SessionEntriesPage = { entries: [], toolResults: [], start: 0,
    end: 0, total: 0, leafId: null, mode: 'build' }
  const api = {
    getEntriesPage: vi.fn().mockResolvedValue(empty),
    getHistoryIndex: vi.fn(async (path: string) => ({ sessionPath: path, totalEntries: 0, landmarks: [] })),
    onEvent: vi.fn(() => () => undefined),
    switchSession: vi.fn(async (path: string) => {
      dispatch({ type: 'session', session: session(path) })
      return { cancelled: false }
    })
  }
  const h = renderHook(() => {
    const [state, nextDispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd: '/project' }, session: session(a),
      busy: true, runningSessionPaths: proof === 'running paths' ? [a] : [],
      liveSessionOwnerPath: a, liveSessionBackendId: proof !== 'running paths' ? 'backend-a' : undefined,
      timeline: rows })
    dispatch = nextDispatch
    return { ...useAgentHistory({ api: api as never, state, dispatch: nextDispatch }), state }
  })
  expect(h.result.current.timelineCache.current.get(a)?.items).toEqual(rows)
  await act(async () => { await h.result.current.switchSession(b) })
  expect(h.result.current.state.timeline).toEqual([])
  if (proof === 'metadata first') beforeCachedPaint = () => dispatch({ type: 'event', event: {
    type: 'agent_start', _pionLive: { backendId: 'backend-a', revision: 8, cwd: '/project', sessionPath: a }
  } })
  await act(async () => { await h.result.current.switchSession(a) })
  expect(h.result.current.state.timeline[0]).toMatchObject({
    id: draft.id, text: 'first token', streaming: true
  })
  expect(h.result.current.state.timeline).toHaveLength(rows.length)
  if (proof !== 'running paths') expect(findTool(h.result.current.state.timeline, tool.tool.id).tool)
    .toMatchObject({ outputText: 'running progress label', status: 'running' })
  expect(h.result.current.state.busy).toBe(true)
  expect(h.result.current.state.timelineLoading).toBe(false)
  await act(async () => dispatch({ type: 'event', event: { type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: ' resumed' } } }))
  expect(h.result.current.state.timeline[0]).toMatchObject({ id: draft.id, text: 'first token resumed' })
})

it.each(['more output', 'first token', 'empty final'] as const)('restores background %s on the first A → B → A switch before a delayed history page', async (mode) => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => callback(0)); return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const a = '/background-a', b = '/background-b', cwd = '/project'
  const pending = deferred<SessionEntriesPage>()
  const empty: SessionEntriesPage = { entries: [], toolResults: [], start: 0, end: 0, total: 0, leafId: null, mode: 'build' }
  let dispatch!: Dispatch<Action>
  const session = (path: string, restore = false) => ({
    sessionId: path, sessionFile: path, messageCount: 0, isStreaming: path === a && mode !== 'empty final',
    ...(path === a && restore ? { liveState: { backendId: 'backend-a', revision: 8, cwd, sessionPath: a, events: [
      { type: 'message_start' as const, message: { role: 'assistant', timestamp: 100, content: [] } },
      { type: 'message_update' as const, usage: null, assistantMessageEvent: { type: 'text_delta', delta: 'background output' } },
      ...(mode === 'empty final' ? [{ type: 'message_end' as const, message: { role: 'assistant', timestamp: 100, content: [] } }] : [
        { type: 'tool_execution_start' as const, toolCallId: 'background-tool', toolName: 'read', args: { path: 'file.ts' } },
        { type: 'tool_execution_end' as const, toolCallId: 'background-tool', toolName: 'read', result: { content: [{ type: 'text', text: 'background result' }] }, isError: false }
      ])
    ] } } : {})
  })
  const api = { onEvent: vi.fn(() => () => undefined), getHistoryIndex: vi.fn().mockResolvedValue(null),
    getEntriesPage: vi.fn((_before, _size, path) => path === a ? pending.promise : Promise.resolve(empty)),
    switchSession: vi.fn(async (path: string) => {
      dispatch({ type: 'session', session: session(path, true) }); return { cancelled: false }
    }) }
  const h = renderHook(() => {
    const [state, nextDispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd }, session: session(a), busy: true, runningSessionPaths: [a],
      timeline: mode === 'first token' ? [] : [{ kind: 'assistant' as const, id: 990, live: true,
        messageTimestamp: 100, text: 'before leaving', thinking: '', streaming: true }] })
    dispatch = nextDispatch
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state }
  })
  await act(async () => { await h.result.current.switchSession(b) })
  let switching!: Promise<unknown>
  await act(async () => {
    switching = h.result.current.switchSession(a)
    // Allow the cached paint, switch RPC and newest-page request to begin.
    for (let tick = 0; tick < 12; tick++) await Promise.resolve()
  })
  if (mode === 'empty final') expect(h.result.current.state.timeline).toEqual([])
  else {
    // A STATE snapshot may arrive after the cached mount but before its page.
    // Both cached and newly materialized background rows need history reveal;
    // subsequent real tokens remain live suffix updates, not snapshot replay.
    expect(h.result.current.state.timeline[0]).toMatchObject({ text: 'background output', streaming: true, historical: true })
    expect(h.result.current.state.timeline.every((row) => row.historical && !row.noReveal)).toBe(true)
    expect(findTool(h.result.current.state.timeline, 'background-tool').tool).toMatchObject({ status: 'done', outputText: 'background result' })
  }
  await act(async () => { pending.resolve(empty); await switching })
  if (mode === 'empty final') expect(h.result.current.state.timeline).toEqual([])
  else expect(h.result.current.state.timeline[0]).toMatchObject({ text: 'background output', streaming: true })
})

it('does not resurrect a pre-final cached draft mounted after background completion', async () => {
  const path = '/empty-before-cache.jsonl', cwd = '/project'
  const pending = deferred<SessionEntriesPage>()
  const draft: TimelineItem = { kind: 'assistant', id: 906, live: true, messageTimestamp: 100,
    text: 'pre-final cache', thinking: '', streaming: true }
  const api = { getEntriesPage: vi.fn(() => pending.promise), onEvent: vi.fn(() => () => undefined),
    getHistoryIndex: vi.fn().mockResolvedValue(null) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState, status: { phase: 'running', cwd },
      session: { sessionId: 'empty', sessionFile: path, messageCount: 0, isStreaming: true },
      timeline: [draft], busy: true })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  let loading!: Promise<void>
  act(() => { loading = h.result.current.reloadTimeline(path) })
  await act(async () => {
    h.result.current.dispatch({ type: 'session', session: {
      sessionId: 'empty', sessionFile: path, messageCount: 0, isStreaming: false,
      liveState: { backendId: 'empty-backend', revision: 8, cwd, sessionPath: path, truncated: true, events: [
        { type: 'message_start', message: { role: 'assistant', timestamp: 100, content: [] } },
        { type: 'message_end', message: { role: 'assistant', timestamp: 100, content: [] } }
      ] }
    } })
  })
  expect(h.result.current.state.timeline).toEqual([])
  act(() => h.result.current.dispatch({ type: 'loadEntries', items: [draft], preserveToolState: {
    revision: h.result.current.state.timelineScopeRevision, cwd, sessionPath: path } }))
  expect(h.result.current.state.timeline).toEqual([])
  await act(async () => {
    pending.resolve({ entries: [], toolResults: [], start: 0, end: 0, total: 0, leafId: null, mode: 'build' })
    await loading
  })
  expect(h.result.current.state.timeline).toEqual([])
  expect(h.result.current.timelineCache.current.get(path)?.items).toEqual([])
})

it.each(['final output', ''])('does not let a late empty disk page rewind the authoritative final %j', async (finalText) => {
  const path = '/live-reload.jsonl'
  const pending = deferred<SessionEntriesPage>()
  const api = { getEntriesPage: vi.fn(() => pending.promise), onEvent: vi.fn(() => () => undefined),
    getHistoryIndex: vi.fn().mockResolvedValue(null) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd: '/project' },
      session: { sessionId: 'live', sessionFile: path, isStreaming: true } as NonNullable<typeof initialState.session>,
      busy: true, timeline: [{ kind: 'assistant', id: 902, live: true,
        messageTimestamp: 100, text: 'provisional', thinking: '', streaming: true }] })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  let loading!: Promise<void>
  act(() => { loading = h.result.current.reloadTimeline(path) })
  await act(async () => {
    // Queue final and response together: preservation must happen in reducer
    // order, not from the hook's earlier pre-final cache snapshot.
    h.result.current.dispatch({ type: 'event', event: { type: 'message_end',
      message: { role: 'assistant', timestamp: 100, content: [{ type: 'text', text: finalText }] } } })
    pending.resolve({ entries: [], toolResults: [], start: 0, end: 0, total: 0, leafId: 'changed', mode: 'build' })
    await loading
  })
  expect(h.result.current.state.timeline).toEqual(finalText ? [expect.objectContaining({
    id: 902, text: finalText, streaming: false
  })] : [])
  expect(h.result.current.timelineCache.current.get(path)?.items).toEqual(h.result.current.state.timeline)
})

it.each(['reload', 'jump'] as const)('releases a never-resolving %s read and ignores its late page', async (operation) => {
  vi.useFakeTimers()
  const path = '/timeout.jsonl'
  const pending = deferred<SessionEntriesPage>()
  const api = { getEntriesPage: vi.fn(() => pending.promise), onEvent: vi.fn(() => () => undefined),
    getHistoryIndex: vi.fn().mockResolvedValue(null) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd: '/project' },
      historyIndex: { sessionPath: path, totalEntries: 1, landmarks: [] } as never })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state }
  })
  h.result.current.timelineOwnerPath.current = path
  let loading!: Promise<void>
  act(() => {
    loading = operation === 'reload' ? h.result.current.reloadTimeline(path)
      : h.result.current.jumpToHistoryLandmark({ entryId: 'target', entryIndex: 0 } as never)
  })
  expect(h.result.current.state.timelineLoading).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); await loading })
  expect(api.getEntriesPage).toHaveBeenCalledTimes(1)
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.result.current.state.timelineError).toBeTruthy()
  await act(async () => {
    pending.resolve({ entries: [{ type: 'message', id: 'late', parentId: null, timestamp: '',
      message: { role: 'user', content: 'must not mount' } }], toolResults: [], start: 0, end: 1,
      total: 1, leafId: 'late', mode: 'build' })
  })
  expect(h.result.current.state.timeline).toEqual([])
})

it.each(['identity', 'cwd'] as const)('releases a discarded %s selection response and leaves the next explicit load retryable', async (change) => {
  const first = deferred<SessionEntriesPage>(), second = deferred<SessionEntriesPage>()
  const path = '/reader.jsonl'
  const api = { getEntriesPage: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    onEvent: vi.fn(() => () => undefined), getHistoryIndex: vi.fn().mockResolvedValue(null) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd: '/project' },
      session: { sessionId: 'original', sessionFile: path } as never })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  h.result.current.timelineOwnerPath.current = path
  let one!: Promise<void>, two!: Promise<void>
  act(() => { one = h.result.current.reloadTimeline(path) })
  await act(async () => {
    if (change === 'cwd') h.result.current.dispatch({ type: 'status', status: { phase: 'running', cwd: '/other-worktree' } })
    else h.result.current.dispatch({ type: 'session', session: {
      sessionId: 'replacement', sessionFile: path
    } as never })
  })
  const page: SessionEntriesPage = { entries: [], toolResults: [], start: 0, end: 0,
    total: 0, leafId: null, mode: 'build' }
  await act(async () => { first.resolve(page); await one })
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.result.current.timelineCache.current.has(path)).toBe(false)
  act(() => { two = h.result.current.reloadTimeline(path) })
  expect(h.result.current.state.timelineLoading).toBe(true)
  await act(async () => { second.resolve(page); await two })
  expect(h.result.current.state.timelineLoading).toBe(false)
})

it('does not let an older A read clear the newest foreground loading shell after A → B → A', async () => {
  const oldA = deferred<SessionEntriesPage>(), b = deferred<SessionEntriesPage>(), newA = deferred<SessionEntriesPage>()
  const api = { getEntriesPage: vi.fn().mockReturnValueOnce(oldA.promise)
    .mockReturnValueOnce(b.promise).mockReturnValueOnce(newA.promise),
    onEvent: vi.fn(() => () => undefined), getHistoryIndex: vi.fn().mockResolvedValue(null) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState, status: { phase: 'running', cwd: '/project' } })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state }
  })
  let first!: Promise<void>, second!: Promise<void>, third!: Promise<void>
  act(() => { h.result.current.timelineOwnerPath.current = '/a'; first = h.result.current.reloadTimeline('/a') })
  act(() => { h.result.current.timelineOwnerPath.current = '/b'; second = h.result.current.reloadTimeline('/b') })
  act(() => { h.result.current.timelineOwnerPath.current = '/a'; third = h.result.current.reloadTimeline('/a') })
  const page: SessionEntriesPage = { entries: [], toolResults: [], start: 0, end: 0,
    total: 0, leafId: null, mode: 'build' }
  await act(async () => { oldA.resolve(page); b.resolve(page); await Promise.all([first, second]) })
  expect(h.result.current.state.timelineLoading).toBe(true)
  await act(async () => { newA.resolve(page); await third })
  expect(h.result.current.state.timelineLoading).toBe(false)
})

it('reports a stalled switch without treating its still-pending backend mutation as cancelled', async () => {
  vi.useFakeTimers()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => callback(0)); return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const pending = deferred<{ cancelled: boolean }>()
  const api = { switchSession: vi.fn(() => pending.promise), getEntriesPage: vi.fn(),
    getHistoryIndex: vi.fn().mockResolvedValue(null) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, initialState)
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state }
  })
  let switching!: Promise<{ cancelled: boolean }>, settled = false
  act(() => { switching = h.result.current.switchSession('/pending'); void switching.then(() => { settled = true }) })
  await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.result.current.state.timelineError).toContain('尚未停止')
  expect(settled).toBe(false)
  expect(api.switchSession).toHaveBeenCalledTimes(1)
  expect(api.getEntriesPage).not.toHaveBeenCalled()
  await act(async () => { pending.resolve({ cancelled: true }); await switching })
})

it.each(['reject', 'throw'] as const)('settles foreground loading after a history IPC %s', async (failure) => {
  vi.useFakeTimers()
  const api = { getEntriesPage: vi.fn(() => {
    if (failure === 'throw') throw new Error('sync IPC failure')
    return Promise.reject(new Error('async IPC failure'))
  }) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, initialState)
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state }
  })
  let loading!: Promise<void>
  act(() => { loading = h.result.current.reloadTimeline('/failed') })
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await loading })
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.result.current.state.timelineError).toBeTruthy()
})

it('publishes a ready worktree list without waiting for slow or rejected sidebar reads', async () => {
  vi.useFakeTimers()
  const pending = deferred<never>()
  const dispatch = vi.fn()
  const subscribe = () => () => undefined
  const api = { onStatus: subscribe, onRunCheckpoint: subscribe, onState: subscribe, onSessions: subscribe,
    onUnreadSessions: subscribe, onRunningSessionPaths: subscribe, onTree: subscribe,
    onProjects: subscribe, onEvent: subscribe, getRunningSessionPaths: vi.fn().mockResolvedValue([]),
    getUnreadSessionPaths: vi.fn().mockResolvedValue([]),
    listBranches: vi.fn((cwd: string) => cwd === '/slow' ? pending.promise : Promise.reject(new Error('no git'))),
    listSessions: vi.fn((cwd: string) => cwd === '/slow' ? pending.promise
      : Promise.resolve([{ id: 'ready', path: '/ready/session', projectCwd: cwd }])) }
  const projects = [{ cwd: '/slow' }, { cwd: '/ready' }] as never
  const options = { api: api as never, dispatch, projects, branchesByProject: {}, sessionsByProject: {},
    optimisticSessionTimers: { current: new Map<string, number>() } }
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const h = renderHook(() => useAgentSubscriptions(options))
  await act(async () => { await Promise.resolve() })
  expect(dispatch).toHaveBeenCalledWith({ type: 'projectSessionsUpdate', cwd: '/ready',
    sessions: [{ id: 'ready', path: '/ready/session', projectCwd: '/ready' }] })
  expect(dispatch.mock.calls.some(([action]) => action.type === 'projectSessions')).toBe(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
  expect(warn).toHaveBeenCalled()
  h.unmount()
})

it('accepts the first history response when the selected SDK identity and file arrive late', async () => {
  const path = '/late-sdk-file.jsonl'
  const pending = deferred<SessionEntriesPage>()
  const api = { getEntriesPage: vi.fn(() => pending.promise), onEvent: vi.fn(() => () => undefined),
    getHistoryIndex: vi.fn().mockResolvedValue(null) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd: '/project' },
      timeline: [{ kind: 'assistant', id: 903, live: true, text: 'visible', thinking: '', streaming: true }] })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  h.result.current.timelineOwnerPath.current = path
  let loading!: Promise<void>
  act(() => { loading = h.result.current.reloadTimeline(path) })
  await act(async () => h.result.current.dispatch({ type: 'session', session: {
    sessionId: 'late-id', sessionFile: path, isStreaming: true
  } as NonNullable<typeof initialState.session> }))
  await act(async () => {
    pending.resolve({ entries: [], toolResults: [], start: 0, end: 0, total: 0, leafId: null, mode: 'build' })
    await loading
  })
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.result.current.state.timeline).toEqual([expect.objectContaining({ id: 903, text: 'visible', streaming: true })])
})

it.each(['stopped backend', 'other cwd'])('does not restore cached partial output for %s', async (reason) => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => callback(0))
    return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const path = '/obsolete-live.jsonl'
  const api = { switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
    getEntriesPage: vi.fn().mockResolvedValue({ entries: [], toolResults: [], start: 0, end: 0,
      total: 0, leafId: null, mode: 'build' }), getHistoryIndex: vi.fn().mockResolvedValue(null) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd: '/project' }, runningSessionPaths: reason === 'other cwd' ? [path] : [] })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state }
  })
  h.result.current.timelineCache.current.set(path, {
    cwd: reason === 'other cwd' ? '/different-worktree' : '/project',
    items: [{ kind: 'assistant', id: 904, text: 'obsolete', thinking: '', streaming: true, live: true }],
    mode: 'build', apiBefore: 0, apiAfter: 0, toolResults: [], complete: true,
    newerComplete: true, leafId: null, total: 0
  })
  // The known selected cwd, rather than an obsolete cache descriptor, owns
  // this fixture. Unknown callers may legitimately derive a target cache cwd.
  await act(async () => { await h.result.current.switchSession(path, '/project') })
  expect(h.result.current.state.timeline).toEqual([])
  expect(h.result.current.state.busy).toBe(false)
})

it('drops a cached streaming tail when the selected backend is recreated before empty history revalidation', async () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => callback(0)); return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const path = '/recreated-backend.jsonl', cwd = '/project'
  let dispatch!: Dispatch<Action>
  const api = { onEvent: vi.fn(() => () => undefined), getHistoryIndex: vi.fn().mockResolvedValue(null),
    getEntriesPage: vi.fn().mockResolvedValue({ entries: [], toolResults: [], start: 0, end: 0,
      total: 0, leafId: null, mode: 'build' }),
    switchSession: vi.fn(async () => {
      dispatch({ type: 'session', session: { sessionId: 'reopened', sessionFile: path,
        messageCount: 0, isStreaming: false, liveState: { backendId: 'replacement-backend', revision: 1,
          cwd, sessionPath: path, events: [] } } })
      return { cancelled: false }
    }) }
  const h = renderHook(() => {
    const [state, nextDispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd }, runningSessionPaths: [path] })
    dispatch = nextDispatch
    return { ...useAgentHistory({ api: api as never, state, dispatch: nextDispatch }), state }
  })
  h.result.current.timelineCache.current.set(path, { cwd, liveSessionBackendId: 'old-backend',
    items: [{ kind: 'assistant', id: 905, text: 'obsolete backend draft', thinking: '', streaming: true, live: true }],
    mode: 'build', apiBefore: 0, apiAfter: 0, toolResults: [], complete: true,
    newerComplete: true, leafId: null, total: 0 })
  await act(async () => { await h.result.current.switchSession(path) })
  expect(h.result.current.state.timeline).toEqual([])
  expect(h.result.current.state.liveSessionBackendId).toBe('replacement-backend')
  expect(h.result.current.state.busy).toBe(false)
})

it('keeps short final authority through same-leaf cache replay despite unrelated budget loss', () => {
  const cwd = '/project', path = '/short-final.jsonl'
  const draft: TimelineItem = { kind: 'assistant', id: 950, live: true, messageTimestamp: 100,
    text: 'long cached draft', thinking: 'long cached reasoning', streaming: true }
  const seed = { ...initialState, status: { phase: 'running' as const, cwd }, timeline: [draft], busy: true }
  const ended = reducer(seed, { type: 'session', session: {
    sessionId: 'short', sessionFile: path, messageCount: 0, isStreaming: false,
    liveState: { backendId: 'short-backend', revision: 8, cwd, sessionPath: path, truncated: true, events: [
      { type: 'message_start', message: { role: 'assistant', timestamp: 100, content: [] } },
      { type: 'message_end', message: { role: 'assistant', timestamp: 100, content: [
        { type: 'text', text: 'final' }, { type: 'thinking', thinking: 'brief' }
      ] } }
    ] }
  } })
  const restored = reducer(ended, { type: 'loadEntries', items: [draft], preserveToolState: {
    revision: ended.timelineScopeRevision, cwd, sessionPath: path } })
  expect(restored.timeline[0]).toMatchObject({ id: draft.id, text: 'final', thinking: 'brief', streaming: false })
})

it('keeps identical snapshot image previews and their mounted disclosure DOM without reprojecting', () => {
  const toolCallId = 'snapshot-image', path = '/snapshot-image-session', cwd = '/project'
  const result = imageResultEntry(toolCallId, 'saved image').message!
  const completed = applyToolResult({ id: toolCallId, name: IMAGE_GENERATION_TOOL_NAME,
    status: 'running', isError: false, live: true }, result, false, 'message')
  const row: TimelineItem = { kind: 'tool', id: 1990, noReveal: true, tool: completed }
  const state = { ...initialState, status: { phase: 'running' as const, cwd }, timeline: [row],
    liveSessionBackendId: 'backend-image', liveSessionRevision: 3 }
  const view = render(<ToolHistoryRows items={state.timeline} />)
  fireEvent.click(screen.getByRole('button', { name: '展开生图工具详情' }))
  const head = screen.getByRole('button', { name: '收起生图工具详情' })
  const image = screen.getByRole('img')
  fireEvent.load(image)
  const project = vi.spyOn(toolImages, 'collectToolImages')
  const next = reducer(state, { type: 'session', session: {
    sessionId: path, sessionFile: path, messageCount: 1, isStreaming: true,
    liveState: { backendId: 'backend-image', revision: 5, cwd, sessionPath: path, events: [
      { type: 'tool_execution_start', toolCallId, toolName: IMAGE_GENERATION_TOOL_NAME, args: { path: 'images/output.png' } },
      { type: 'tool_execution_end', toolCallId, toolName: IMAGE_GENERATION_TOOL_NAME, result, isError: false },
      { type: 'message_end', message: result }
    ] }
  } })
  expect(project).not.toHaveBeenCalled()
  expect(findTool(next.timeline, toolCallId).id).toBe(row.id)
  expect(findTool(next.timeline, toolCallId).tool.images).toBe(completed.images)
  view.rerender(<ToolHistoryRows items={next.timeline} />)
  expect(screen.getByRole('button', { name: '收起生图工具详情' })).toBe(head)
  expect(screen.getByRole('img')).toBe(image)
  expect(image.parentElement).toHaveAttribute('data-image-state', 'loaded')
})

it.each(['older', 'newer', 'index'] as const)('rejects late %s reads after an external session identity change', async (operation) => {
  const a = '/external-a.jsonl', b = '/external-b.jsonl'
  const pendingPage = deferred<SessionEntriesPage>()
  const pendingIndex = deferred<{ sessionPath: string; totalEntries: number; landmarks: [] }>()
  const api = { getEntriesPage: vi.fn(() => pendingPage.promise),
    getHistoryIndex: vi.fn(() => pendingIndex.promise), onEvent: vi.fn(() => () => undefined) }
  const oldIndex = { sessionPath: a, totalEntries: 3, landmarks: [] }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd: '/project' },
      session: { sessionId: 'a', sessionFile: a } as never,
      historyIndex: oldIndex,
      timeline: [{ kind: 'user', id: 1, text: 'existing' }] as TimelineItem[] })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  h.result.current.historyCursor.current = { path: a, items: h.result.current.state.timeline,
    mode: 'build', apiBefore: 1, apiAfter: 2, total: 3, toolResults: [], complete: false,
    newerComplete: false, leafId: 'old', loading: false, loadId: h.result.current.timelineLoadId.current }
  let read!: Promise<void>
  act(() => { read = operation === 'index' ? h.result.current.refreshHistoryIndex(a)
    : operation === 'older' ? h.result.current.loadOlder() : h.result.current.loadNewer() })
  act(() => h.result.current.dispatch({ type: 'session', session: { sessionId: 'b', sessionFile: b } as never }))
  await act(async () => {
    pendingPage.resolve({ entries: [{ type: 'message', id: 'wrong', parentId: null, timestamp: '',
      message: { role: 'user', content: 'wrong session page' } }], toolResults: [], start: 0, end: 3,
      total: 3, leafId: 'wrong', mode: 'build' })
    pendingIndex.resolve({ sessionPath: a, totalEntries: 999, landmarks: [] })
    await read
  })
  expect(h.result.current.state.timeline).toEqual([{ kind: 'user', id: 1, text: 'existing' }])
  expect(h.result.current.state.historyIndex).toBe(oldIndex)
})

it('does not seed failed empty history as a successful cache and reports failure again on revisit', async () => {
  vi.useFakeTimers()
  const path = '/cold-failure.jsonl'
  const api = { getEntriesPage: vi.fn().mockResolvedValue(null),
    getHistoryIndex: vi.fn().mockResolvedValue(null), onEvent: vi.fn(() => () => undefined) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd: '/project' },
      session: { sessionId: 'cold', sessionFile: path } as never })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state }
  })
  for (let visit = 0; visit < 2; visit++) {
    let read!: Promise<void>
    act(() => { read = h.result.current.reloadTimeline(path) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await read })
    expect(h.result.current.state.timelineLoading).toBe(false)
    expect(h.result.current.state.timelineError).toBeTruthy()
    expect(h.result.current.timelineCache.current.has(path)).toBe(false)
  }
})

it('keeps one reversible user row when a safe STATE projection follows its persisted history page', async () => {
  const cwd = '/project', path = '/user-identity.jsonl', timestamp = 1_780_000_000_000
  const api = { getEntriesPage: vi.fn().mockResolvedValue({ entries: [
    { type: 'message', id: 'user-entry-a', parentId: null, timestamp: '', message: {
      role: 'user', timestamp, content: [{ type: 'text', text: '安装这个吧' }, previewPart] } }
  ], toolResults: [], leafId: 'user-entry-a', total: 1, start: 0, end: 1, hasOlder: false, hasNewer: false }),
  getHistoryIndex: vi.fn().mockResolvedValue(null), onEvent: vi.fn(() => () => undefined) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState, status: { phase: 'running', cwd },
      session: { sessionId: 'user', sessionFile: path } as never })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  await act(async () => { await h.result.current.reloadTimeline(path) })
  const old = h.result.current.state.timeline[0]
  const view = render(<ToolHistoryRows items={h.result.current.state.timeline} />)
  const bubble = screen.getByText('安装这个吧')
  act(() => h.result.current.dispatch({ type: 'session', session: {
    sessionId: 'user', sessionFile: path, messageCount: 1, isStreaming: false,
    liveState: { backendId: 'backend-user', revision: 2, cwd, sessionPath: path, events: [
      { type: 'message_start', message: { role: 'user', timestamp: String(timestamp),
        content: '安装这个吧', _pionLiveMessageId: 'backend-user:1' } }
    ] }
  } }))
  view.rerender(<ToolHistoryRows items={h.result.current.state.timeline} />)
  expect(screen.getAllByText('安装这个吧')).toHaveLength(1)
  expect(screen.getByText('安装这个吧')).toBe(bubble)
  expect(h.result.current.state.timeline[0]).toMatchObject({ id: old.id,
    entryId: 'user-entry-a', liveMessageId: 'backend-user:1' })
  expect(h.result.current.state.timeline[0].kind === 'user' && h.result.current.state.timeline[0].images)
    .toEqual(old.kind === 'user' ? old.images : undefined)
})

it('keeps newly selected live output when its first history read fails', async () => {
  vi.useFakeTimers()
  const path = '/live-failure.jsonl'
  const api = { getEntriesPage: vi.fn().mockResolvedValue(null),
    getHistoryIndex: vi.fn().mockResolvedValue(null), onEvent: vi.fn(() => () => undefined) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd: '/project' },
      session: { sessionId: 'live', sessionFile: path } as never })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  let read!: Promise<void>
  act(() => { read = h.result.current.reloadTimeline(path) })
  act(() => h.result.current.dispatch({ type: 'session', session: {
    sessionId: 'live', sessionFile: path, messageCount: 0, isStreaming: true,
    liveState: { backendId: 'live-backend', revision: 1, cwd: '/project', sessionPath: path,
      events: [{ type: 'message_start', message: { role: 'assistant', timestamp: 100, content: [] } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'still streaming' } }] }
  } as never }))
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await read })
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.result.current.state.timeline.some((item) => item.kind === 'assistant' && item.streaming)).toBe(true)
  expect(h.result.current.timelineCache.current.get(path)?.items.length).toBeGreaterThan(0)
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

it.each(['owned snapshot', 'late previous selection'] as const)('pulls unpersisted background display independently of same-leaf history: %s', async (mode) => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queueMicrotask(() => callback(0)); return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const a = '/pulled-a', b = '/pulled-b', cwd = '/project'
  const pending = deferred<NonNullable<typeof initialState.session>>()
  const empty: SessionEntriesPage = { entries: [], toolResults: [], start: 0,
    end: 0, total: 0, leafId: null, mode: 'build' }
  const session = (path: string) => ({ sessionId: path, sessionFile: path,
    messageCount: 0, isStreaming: path === a })
  let dispatch!: Dispatch<Action>
  const api = {
    onEvent: vi.fn(() => () => undefined),
    getEntriesPage: vi.fn().mockResolvedValue(empty),
    getHistoryIndex: vi.fn().mockResolvedValue(null),
    getState: vi.fn(() => pending.promise),
    switchSession: vi.fn(async (path: string) => {
      dispatch({ type: 'session', session: session(path) }); return { cancelled: false }
    })
  }
  const h = renderHook(() => {
    const [state, nextDispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd }, session: session(b) })
    dispatch = nextDispatch
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state }
  })
  await act(async () => { await h.result.current.switchSession(a) })
  expect(api.getState).toHaveBeenCalledTimes(1)
  if (mode === 'late previous selection') await act(async () => { await h.result.current.switchSession(b) })
  await act(async () => { pending.resolve({ ...session(a), liveState: {
    backendId: 'pulled-backend', revision: 8, cwd, sessionPath: a, events: [
      { type: 'message_start', message: { role: 'assistant', timestamp: 100, content: [] } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'background first token' } },
      { type: 'tool_execution_start', toolCallId: 'pulled-tool', toolName: 'read', args: { path: 'file.ts' } },
      { type: 'tool_execution_update', toolCallId: 'pulled-tool', toolName: 'read', args: { path: 'file.ts' },
        partialResult: { content: [{ type: 'text', text: 'running label' }] } }
    ]
  } } as NonNullable<typeof initialState.session>) })
  if (mode === 'late previous selection') {
    expect(h.result.current.state.timeline).toEqual([])
    expect(h.result.current.state.session?.sessionFile).toBe(b)
  } else {
    expect(h.result.current.state.timeline[0]).toMatchObject({ text: 'background first token', streaming: true })
    expect(findTool(h.result.current.state.timeline, 'pulled-tool').tool).toMatchObject({ status: 'running', outputText: 'running label' })
  }
})

it('rebuilds an empty cached projection from an unchanged nonempty persisted window', async () => {
  const path = '/synthetic-empty-projection.jsonl'
  const page: SessionEntriesPage = { entries: [{ type: 'message', id: 'stored-user',
    parentId: null, timestamp: '', message: { role: 'user', content: 'persisted question' } }],
    toolResults: [], start: 3077, end: 3078, total: 3078, leafId: 'same-leaf', mode: 'build' }
  const pending = deferred<SessionEntriesPage>()
  const api = { getEntriesPage: vi.fn(() => pending.promise),
    getHistoryIndex: vi.fn().mockResolvedValue(null), onEvent: vi.fn(() => () => undefined) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd: '/project' },
      session: { sessionId: 'stored', sessionFile: path, messageCount: 3078, isStreaming: false } })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state }
  })
  h.result.current.timelineCache.current.set(path, { items: [], mode: 'build', apiBefore: 3077,
    apiAfter: 3078, total: 3078, leafId: 'same-leaf', toolResults: [], complete: false, newerComplete: true })
  let read!: Promise<void>
  act(() => { read = h.result.current.reloadTimeline(path) })
  expect(h.result.current.state.timelineLoading).toBe(true)
  await act(async () => { pending.resolve(page); await read })
  expect(h.result.current.state.timeline).toEqual([expect.objectContaining({ text: 'persisted question', entryId: 'stored-user' })])
  expect(h.result.current.state.timelineError).toBeUndefined()
  expect(h.result.current.state.timelineLoading).toBe(false)
})

it('does not hide a failed read behind a blank cache or treat empty live metadata as persisted emptiness', async () => {
  vi.useFakeTimers()
  const cwd = '/project', path = '/synthetic-empty-live.jsonl'
  const api = { getEntriesPage: vi.fn().mockResolvedValue(null),
    getHistoryIndex: vi.fn().mockResolvedValue(null), onEvent: vi.fn(() => () => undefined) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState, status: { phase: 'running', cwd },
      session: { sessionId: 'stored', sessionFile: path, messageCount: 3078, isStreaming: false } })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state, dispatch }
  })
  act(() => h.result.current.dispatch({ type: 'session', session: {
    sessionId: 'stored', sessionFile: path, messageCount: 3078, isStreaming: false,
    liveState: { backendId: 'empty-live', revision: 1, cwd, sessionPath: path, events: [] }
  } }))
  expect(h.result.current.timelineCache.current.has(path)).toBe(false)
  // A previously blanked cache must not suppress either loading or failure.
  h.result.current.timelineCache.current.set(path, { items: [], mode: 'build', apiBefore: 3077,
    apiAfter: 3078, total: 3078, leafId: 'same-leaf', toolResults: [], complete: false, newerComplete: true })
  let read!: Promise<void>
  act(() => { read = h.result.current.reloadTimeline(path) })
  expect(h.result.current.state.timelineLoading).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await read })
  expect(h.result.current.state.timelineError).toContain('会话历史加载失败')
  expect(h.result.current.state.timelineLoading).toBe(false)
})

it('keeps the loading shell during a switch even when an empty cache already exists', async () => {
  vi.useFakeTimers()
  const path = '/empty-cached-switch.jsonl'
  const pendingSwitch = deferred<{ cancelled: boolean }>()
  const api = { switchSession: vi.fn(() => pendingSwitch.promise),
    getEntriesPage: vi.fn().mockResolvedValue({ entries: [], toolResults: [], start: 0, end: 0,
      total: 0, leafId: null, mode: 'build' }), getHistoryIndex: vi.fn().mockResolvedValue(null) }
  const h = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState,
      status: { phase: 'running', cwd: '/project' } })
    return { ...useAgentHistory({ api: api as never, state, dispatch }), state }
  })
  h.result.current.timelineCache.current.set(path, { items: [], mode: 'build', apiBefore: 0,
    apiAfter: 0, total: 0, leafId: null, toolResults: [], complete: true, newerComplete: true })
  let switching!: Promise<{ cancelled: boolean }>
  act(() => { switching = h.result.current.switchSession(path) })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(api.switchSession).toHaveBeenCalledTimes(1)
  expect(h.result.current.state.timelineLoading).toBe(true)
  expect(h.result.current.state.timelineError).toBeUndefined()
  await act(async () => { pendingSwitch.resolve({ cancelled: false }); await vi.advanceTimersByTimeAsync(100) })
  await switching
  expect(h.result.current.state.timelineLoading).toBe(false)
  expect(h.result.current.state.timelineError).toBeUndefined()
})
