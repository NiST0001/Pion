// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialState } from '../../src/renderer/src/agent/types'
import type { AgentState } from '../../src/renderer/src/agent/types'
import { Composer } from '../../src/renderer/src/features/chat/Composer'
import { useAgentRunActions } from '../../src/renderer/src/hooks/agent/useAgentRunActions'
import type { ImageContent, PionApi } from '../../src/shared/types'

type RunOptions = Parameters<typeof useAgentRunActions>[0]
type RestoredDraft = NonNullable<ComponentProps<typeof Composer>['restoreDraft']>

const firstImage: ImageContent = { type: 'image', mimeType: 'image/png', data: 'Zmlyc3Q=' }
const secondImage: ImageContent = { type: 'image', mimeType: 'image/jpeg', data: 'c2Vjb25k' }
const routes = [
  { action: 'send', other: 'queue', key: 'Enter' },
  { action: 'queue', other: 'send', key: 'Tab' }
] as const
const restoredDrafts: RestoredDraft[] = [
  { id: 'exact-text-only', text: ' \t text-only  message\n \t', images: [] },
  { id: 'exact-text-and-images', text: '  原文第一行\n\t第二行   保留空格\t \n', images: [firstImage, secondImage] },
  { id: 'whitespace-with-image', text: ' \n\t  \n', images: [firstImage] },
  { id: 'image-only-with-duplicates', text: '', images: [secondImage, firstImage, secondImage] }
]

function setup(patch: Partial<AgentState> = {}) {
  const api = {
    send: vi.fn<PionApi['send']>().mockResolvedValue(undefined),
    queue: vi.fn<PionApi['queue']>().mockResolvedValue(undefined)
  }
  const state: AgentState = {
    ...initialState,
    status: { phase: 'running', cwd: '/project' },
    session: { sessionId: 'restored', sessionFile: '/project/session.jsonl', isStreaming: false, messageCount: 2 },
    ...patch
  }
  const refreshModels = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const dispatch = vi.fn<RunOptions['dispatch']>()
  const options: RunOptions = {
    api: api as unknown as PionApi,
    state,
    dispatch,
    refreshModels,
    optimisticSessionTimers: { current: new Map() },
    timelineLoadId: { current: 7 },
    historyIndexLoadId: { current: 9 },
    historyIndexInFlight: { current: { path: '/project/session.jsonl', promise: Promise.resolve() } },
    historyCursor: { current: null },
    timelineCache: { current: new Map() },
    timelineOwnerPath: { current: '/project/session.jsonl' },
    expectedTimeline: { current: { path: '/project/session.jsonl', items: state.timeline } },
    reloadTimeline: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  }
  return { api, dispatch, refreshModels, options }
}

function renderComposer(action: 'send' | 'queue', restoreDraft?: RestoredDraft) {
  const h = setup()
  function Harness() {
    const actions = useAgentRunActions(h.options)
    return <Composer
      busy={action === 'queue'} disabled={false} sendDisabled={false}
      prefill="" history={[]} commands={[]} mode="build" restoreDraft={restoreDraft}
      onModeChange={vi.fn()} onSend={actions.send} onQueue={actions.queue} onAbort={actions.abort}
    />
  }
  render(<Harness />)
  return { ...h, input: screen.getByRole('textbox') }
}

describe.each(routes)('restored Composer drafts through $action IPC', ({ action, other, key }) => {
  afterEach(cleanup)

  it.each(restoredDrafts)('passes $id verbatim with all image blocks in order', async (draft) => {
    const h = renderComposer(action, draft)
    const historyRead = h.options.historyIndexInFlight.current
    const expectedTimeline = h.options.expectedTimeline.current
    expect(h.input).toHaveValue(draft.text)
    expect(screen.queryAllByRole('img')).toHaveLength(draft.images.length)

    await act(async () => { fireEvent.keyDown(h.input, { key }) })

    expect(h.api[action]).toHaveBeenCalledExactlyOnceWith(draft.text, draft.images)
    expect(h.api[other]).not.toHaveBeenCalled()
    expect(h.refreshModels).toHaveBeenCalledTimes(1)
    expect(h.dispatch).not.toHaveBeenCalled()
    expect(h.options.timelineLoadId.current).toBe(7)
    expect(h.options.historyIndexLoadId.current).toBe(9)
    expect(h.options.historyIndexInFlight.current).toBe(historyRead)
    expect(h.options.expectedTimeline.current).toBe(expectedTimeline)
    expect(h.options.timelineOwnerPath.current).toBe('/project/session.jsonl')
    expect(screen.getByRole('textbox')).toBe(h.input)
    expect(h.input).toHaveValue('')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('retains ordinary Composer trimming without changing interior whitespace', async () => {
    const h = renderComposer(action)
    fireEvent.change(h.input, { target: { value: ' \t ordinary   draft\n  second line \n ' } })

    await act(async () => { fireEvent.keyDown(h.input, { key }) })

    expect(h.api[action]).toHaveBeenCalledExactlyOnceWith('ordinary   draft\n  second line', [])
    expect(h.api[other]).not.toHaveBeenCalled()
    expect(h.refreshModels).toHaveBeenCalledTimes(1)
    expect(h.input).toHaveValue('')
  })

  it('rejects empty or whitespace-only input without images at the hook boundary', async () => {
    const h = setup()
    const { result } = renderHook(() => useAgentRunActions(h.options))

    await act(async () => {
      await result.current[action]('')
      await result.current[action](' \n\t \u00a0 ')
      await result.current[action](' \n\t ', [])
    })

    expect(h.api.send).not.toHaveBeenCalled()
    expect(h.api.queue).not.toHaveBeenCalled()
    expect(h.refreshModels).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
    expect(h.options.optimisticSessionTimers.current.size).toBe(0)
  })
})

describe('verbatim sends retain optimistic session behavior', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it.each([
    { text: '  first\n\t restored message \n', images: [], preview: 'first restored message' },
    { text: ' \n\t ', images: [firstImage], preview: '图片消息' }
  ])('formats only the sidebar preview and expires its placeholder: $preview', async ({ text, images, preview }) => {
    vi.useFakeTimers()
    const h = setup({ session: { sessionId: 'restored', isStreaming: false, messageCount: 0 } })
    const { result } = renderHook(() => useAgentRunActions(h.options))

    await act(async () => { await result.current.send(text, images) })

    expect(h.api.send).toHaveBeenCalledExactlyOnceWith(text, images)
    expect(h.refreshModels).toHaveBeenCalledTimes(1)
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: 'optimisticSession',
      session: expect.objectContaining({
        projectCwd: '/project', path: 'pion:pending:restored', id: 'restored',
        preview, messageCount: 1, optimistic: true
      })
    })
    expect(h.options.optimisticSessionTimers.current.has('/project\u0000restored')).toBe(true)
    act(() => { vi.advanceTimersByTime(29_999) })
    expect(h.dispatch).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1) })
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'removeOptimisticSession', cwd: '/project', id: 'restored' })
    expect(h.options.optimisticSessionTimers.current.size).toBe(0)
  })

  it('removes the placeholder and timer on a failed send without refreshing models', async () => {
    vi.useFakeTimers()
    const h = setup({ session: { sessionId: 'restored', isStreaming: false, messageCount: 0 } })
    const failure = new Error('send failed')
    h.api.send.mockRejectedValueOnce(failure)
    const { result } = renderHook(() => useAgentRunActions(h.options))
    const text = '  preserved even on failure\n'

    await act(async () => { await expect(result.current.send(text, [firstImage])).rejects.toBe(failure) })

    expect(h.api.send).toHaveBeenCalledExactlyOnceWith(text, [firstImage])
    expect(h.dispatch).toHaveBeenCalledTimes(2)
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'removeOptimisticSession', cwd: '/project', id: 'restored' })
    expect(h.options.optimisticSessionTimers.current.size).toBe(0)
    expect(h.refreshModels).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.dispatch).toHaveBeenCalledTimes(2)
  })
})
