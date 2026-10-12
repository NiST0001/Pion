// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as modelError from '../../src/renderer/src/agent/modelError'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { entriesToTimeline } from '../../src/renderer/src/agent/timeline'
import { initialState } from '../../src/renderer/src/agent/types'
import { ChatMessage } from '../../src/renderer/src/features/chat/ChatMessage'
import { Markdown } from '../../src/renderer/src/features/chat/Markdown'
import { SCREEN_TEXT_REVEAL_LIVE_DURATION_MS, SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS, SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS } from '../../src/renderer/src/utils/screenTextReveal'
import { ChatTimeline } from '../../src/renderer/src/features/chat/ChatTimeline'
import type { ChatTimelineProps } from '../../src/renderer/src/features/chat/ChatTimeline'
import {
  assignPendingLineDelays,
  resetLineRevealClock,
  takeLineRevealSlot
} from '../../src/renderer/src/utils/screenTextReveal'

const persistedUserMessage = {
  kind: 'user',
  id: 6,
  entryId: 'user-entry-6',
  text: '调整这条消息之后的会话',
  historical: true
} as const

describe('ChatMessage', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('adds send motion only to a new live user bubble and never replays it on entry backfill', () => {
    const item = { kind: 'user' as const, id: 42, text: '发送消息', live: true }
    const view = render(<ChatMessage item={item} canFork={false} />)
    const bubble = view.container.querySelector('.bubble-user')!
    expect(bubble).toHaveClass('user-send-entering')
    expect(bubble).toHaveAttribute('data-line-reveal-ready', 'true')
    const delay = (bubble as HTMLElement).style.getPropertyValue('--screen-text-reveal-delay')
    view.rerender(<ChatMessage item={{ ...item, entryId: 'persisted' }} canFork={false} />)
    expect(view.container.querySelector('.bubble-user')).toBe(bubble)
    expect((bubble as HTMLElement).style.getPropertyValue('--screen-text-reveal-delay')).toBe(delay)
    const finish = (target: Element, name: string) => {
      const event = new Event('webkitAnimationEnd', { bubbles: true })
      Object.defineProperty(event, 'animationName', { value: name })
      fireEvent(target, event)
    }
    finish(bubble.querySelector('.bubble-content')!, 'user-message-arrive')
    expect(bubble).toHaveClass('user-send-entering')
    finish(bubble, 'screen-text-reveal')
    expect(bubble).toHaveClass('user-send-entering')
    finish(bubble, 'user-message-arrive')
    expect(bubble).not.toHaveClass('user-send-entering')
    view.rerender(<ChatMessage item={{ ...item, entryId: 'persisted', text: '发送消息' }} canFork={false} />)
    expect(view.container.querySelector('.bubble-user')).toBe(bubble)
    expect(bubble).not.toHaveClass('user-send-entering')
  })

  it.each([
    { historical: true, live: true }, { noReveal: true, live: true }, { live: false }
  ])('does not play send motion on history, paging or nonlive mounts: %j', (flags) => {
    const view = render(<ChatMessage item={{ kind: 'user', id: 43, text: '旧消息', ...flags }} canFork={false} />)
    expect(view.container.querySelector('.bubble-user')).not.toHaveClass('user-send-entering')
  })

  it('keeps readonly user messages static and composes motion with reduced-motion-safe opacity', () => {
    const view = render(<ChatMessage item={{ kind: 'user', id: 44, text: '只读', live: true }} canFork={false} readOnly />)
    expect(view.container.querySelector('.bubble-user')).not.toHaveClass('user-send-entering')
    const css = readFileSync('src/renderer/src/styles/refinements.css', 'utf8')
    expect(css).toContain('animation-name: screen-text-reveal, user-message-arrive;')
    expect(css).toContain('animation-duration: 560ms, 420ms;')
    expect(css).toContain('from { transform: translateY(8px); }')
    expect(css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)')))
      .toContain('.bubble-user.user-send-entering[data-line-reveal-ready="true"]')
  })

  it('does not leave blank completed assistant bubbles between child tools', () => {
    const item = { kind: 'assistant' as const, id: 88, text: '', thinking: '', streaming: false }
    const props = { item, canFork: false, onFork: vi.fn() }
    const view = render(<ChatMessage {...props} readOnly />)
    expect(view.container.querySelector('.row-assistant')).toBeNull()
    view.rerender(<ChatMessage {...props} readOnly item={{ ...item, thinking: '保留真实思考' }} />)
    expect(view.container.querySelector('details.thinking pre')).toHaveTextContent('保留真实思考')
    view.rerender(<ChatMessage {...props} readOnly item={{ ...item, text: '保留真实回复' }} />)
    expect(view.container.querySelector('.bubble-assistant')).toHaveTextContent('保留真实回复')
    view.rerender(<ChatMessage {...props} />)
    expect(view.container.querySelector('.row-assistant')).not.toBeNull()
  })

  it('scopes compact adjacent-tool spacing to child timelines without reducing click targets', () => {
    const css = readFileSync('src/renderer/src/styles/subagent-sessions.css', 'utf8')
    expect(css).toMatch(/\.child-chat-scroll\s+\.timeline\s*>\s*\.tool-call\s*\+\s*\.tool-call\s*\{\s*margin-top:\s*-12px;\s*\}/)
    expect(css).not.toMatch(/(?:^|\})\s*\.tool-head\s*\{/)
  })

  it('keeps ordinary user bubbles but fails closed on actions and attachments in read-only mode', () => {
    const onFork = vi.fn(), onRevert = vi.fn()
    const item = { ...persistedUserMessage, images: [{ type: 'image' as const, mimeType: 'image/png', data: 'AAAA' }] }
    const props = { item, canFork: true, canRevert: true, onFork, onRevert }
    const view = render(<ChatMessage {...props} readOnly />)
    const bubble = view.container.querySelector('.bubble-user')
    expect(bubble).toHaveTextContent(item.text)
    expect(bubble).toHaveClass('screen-text-reveal-line-history')
    expect(view.container.querySelector('[data-entry-id], img, .message-actions')).toBeNull()
    expect(onFork).not.toHaveBeenCalled()
    expect(onRevert).not.toHaveBeenCalled()

    view.rerender(<ChatMessage {...props} />)
    expect(view.container.querySelector('.bubble-user')).toBe(bubble)
    expect(view.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    fireEvent.click(view.getByRole('button', { name: '分叉' }))
    fireEvent.click(view.getByRole('button', { name: '撤销' }))
    expect(onFork).toHaveBeenCalledExactlyOnceWith(item.entryId)
    expect(onRevert).toHaveBeenCalledExactlyOnceWith(item.entryId)
  })

  it('renders read-only Markdown, thinking, code and tables without navigable links or media', () => {
    const item = { kind: 'assistant' as const, id: 40, streaming: false, historical: true,
      thinking: '先分析现有实现', text: '**普通格式** [链接](https://example.test) ![图片描述](https://example.test/image.png)\n\n'
        + 'https://example.test/auto\n\n```ts\nconst answer = 42\n```\n\n| 列 |\n| --- |\n| 数据 |\n\n'
        + '<img src="https://example.test/raw.png" />\n<video src="https://example.test/v" />\n'
        + '<audio src="https://example.test/a" />\n<iframe src="https://example.test/f" />\n'
        + '<script>alert(1)</script>' }
    const view = render(<ChatMessage item={item} canFork readOnly />)
    expect(view.container.querySelector('.bubble-assistant')).toHaveClass('screen-text-reveal-line-history')
    expect(view.container.querySelector('.thinking summary')).toHaveTextContent('思考过程')
    expect(view.container.querySelector('.thinking pre')).toHaveTextContent(item.thinking)
    expect(view.container.querySelector('.markdown strong')).toHaveTextContent('普通格式')
    expect(view.container.querySelector('.markdown')).toHaveTextContent('链接')
    expect(view.container.querySelector('.markdown')).toHaveTextContent('图片描述')
    expect(view.container.querySelector('.code-block pre code')).toHaveTextContent('const answer = 42')
    expect(view.container.querySelector('table td')).toHaveTextContent('数据')
    expect(view.container.querySelector('.markdown .screen-text-reveal-line-history')).not.toBeNull()
    expect(view.container.querySelector('img, a, video, audio, iframe, script, [href], [src]')).toBeNull()
    expect(view.container.querySelector('.markdown')).not.toHaveTextContent('alert(1)')

    view.rerender(<ChatMessage item={{ ...item, text: '[普通链接](https://example.test) ![普通图片](https://example.test/image.png)' }} canFork={false} />)
    expect(view.getByRole('link', { name: '普通链接' })).toHaveAttribute('href', 'https://example.test')
    expect(view.getByRole('img', { name: '普通图片' })).toHaveAttribute('src', 'https://example.test/image.png')
  })

  it('exposes live user locators without inventing an entry ID and keeps them stable on a late real attachment', () => {
    const message = { role: 'user' as const, timestamp: '1767225600000',
      _pionLiveMessageId: 'fixture-backend:1', content: '当前用户轮次' }
    const started = reducer(initialState, { type: 'event', event: { type: 'message_start', message } })
    const ended = reducer(started, { type: 'event', event: { type: 'message_end', message } })
    const item = ended.timeline[0]
    if (item?.kind !== 'user') throw new Error('Expected the synthetic live user row')
    expect(item.entryId).toBeUndefined()
    const onFork = vi.fn(), onRevert = vi.fn()
    const props = { canFork: true, canRevert: true, onFork, onRevert }
    const { container, queryByRole, getByRole, rerender } = render(<ChatMessage item={item} {...props} />)
    const row = container.querySelector('.row-user')
    expect(row).toHaveAttribute('data-live-message-id', 'fixture-backend:1')
    expect(row).toHaveAttribute('data-user-message-time', '1767225600000')
    expect(row).not.toHaveAttribute('data-entry-id')
    expect(queryByRole('button', { name: '分叉' })).not.toBeInTheDocument()
    expect(queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()

    const attached = reducer(ended, { type: 'event', event: { type: 'entry_appended', entry: {
      type: 'message', id: 'real-user-entry', parentId: null,
      timestamp: '2026-01-01T00:00:00.001Z', message
    } } })
    const persisted = attached.timeline[0]
    if (persisted?.kind !== 'user') throw new Error('Expected the attached synthetic user row')
    rerender(<ChatMessage item={persisted} {...props} />)
    expect(container.querySelector('.row-user')).toBe(row)
    expect(row).toHaveAttribute('data-entry-id', 'real-user-entry')
    expect(row).toHaveAttribute('data-live-message-id', 'fixture-backend:1')
    expect(row).toHaveAttribute('data-user-message-time', '1767225600000')
    expect(item.entryId).toBeUndefined()
    fireEvent.click(getByRole('button', { name: '分叉' }))
    fireEvent.click(getByRole('button', { name: '撤销' }))
    expect(onFork).toHaveBeenCalledExactlyOnceWith('real-user-entry')
    expect(onRevert).toHaveBeenCalledExactlyOnceWith('real-user-entry')
  })

  it('uses the normalized SDK message clock rather than the independently generated entry timestamp', () => {
    const items = entriesToTimeline([{ type: 'message', id: 'clock-entry', parentId: null,
      timestamp: '2026-01-01T00:00:00.001Z',
      message: { role: 'user', content: '两个不同的时钟', timestamp: '2026-01-01T00:00:00.000Z' }
    }])
    const item = items[0]
    if (item?.kind !== 'user') throw new Error('Expected the synthetic persisted user row')
    const { container, rerender } = render(<ChatMessage item={item} canFork={false} />)
    const row = container.querySelector('.row-user')
    expect(row).toHaveAttribute('data-user-message-time', '1767225600000')
    expect(row).not.toHaveAttribute('data-live-message-id')
    expect(row).toHaveAttribute('data-entry-id', 'clock-entry')
    rerender(<ChatMessage item={{ ...item, messageTimestamp: undefined }} canFork={false} />)
    expect(container.querySelector('.row-user')).toBe(row)
    expect(row).not.toHaveAttribute('data-user-message-time')
    expect(row).toHaveAttribute('data-entry-id', 'clock-entry')
  })

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'does not expose an unknown or invalid message timestamp (%s) or substitute append time', (messageTimestamp) => {
      const { container } = render(<ChatMessage item={{ ...persistedUserMessage,
        timestamp: '2026-01-01T00:00:00.001Z', messageTimestamp
      }} canFork={false} />)
      expect(container.querySelector('.row-user')).not.toHaveAttribute('data-user-message-time')
    }
  )

  it.each([undefined, '', 'x'.repeat(513)])('omits unavailable or unbounded live locators', (liveMessageId) => {
    const { container } = render(<ChatMessage item={{ ...persistedUserMessage, liveMessageId }} canFork={false} />)
    expect(container.querySelector('.row-user')).not.toHaveAttribute('data-live-message-id')
  })

  it('mounts the last unresolved user turn and identical sends without reusing the previous persisted entry ID', () => {
    const props: ChatTimelineProps = {
      scrollRef: createRef<HTMLDivElement>(), onScroll: vi.fn(),
      timeline: [persistedUserMessage,
        { kind: 'user', id: 7, text: persistedUserMessage.text, live: true,
          liveMessageId: 'fixture-backend:2', messageTimestamp: 1767225600000 },
        { kind: 'user', id: 8, text: persistedUserMessage.text, live: true,
          liveMessageId: 'fixture-backend:3', messageTimestamp: 1767225600000 }],
      timelineLoading: false, busy: true, starting: false, hasSessions: true,
      canFork: true, onFork: vi.fn(), canRevert: false, onRevert: vi.fn(),
      agentActivity: true, workingStatus: { label: '运行中' }, latestRunChanges: [],
      runCheckpoint: null, rollbackBusy: false, rollbackError: '',
      onUndo: vi.fn(), onReview: vi.fn(), onSelectChange: vi.fn()
    }
    const { container } = render(<ChatTimeline {...props} />)
    const rows = container.querySelectorAll('.row-user')
    expect(rows).toHaveLength(3)
    expect(container.querySelectorAll('.row-user[data-entry-id]')).toHaveLength(1)
    expect(rows[0]).toHaveAttribute('data-entry-id', 'user-entry-6')
    expect(rows[1]).toHaveAttribute('data-live-message-id', 'fixture-backend:2')
    expect(rows[2]).toHaveAttribute('data-live-message-id', 'fixture-backend:3')
    for (const row of [rows[1], rows[2]]) {
      expect(row).not.toHaveAttribute('data-entry-id')
      expect(row).toHaveAttribute('data-user-message-time', '1767225600000')
      expect(row.querySelector('.message-actions')).not.toBeInTheDocument()
    }
  })

  it('reverts the persisted user entry independently of the adjacent fork action', () => {
    const onRevert = vi.fn()
    const onFork = vi.fn()
    const { getByRole } = render(
      <ChatMessage
        item={persistedUserMessage}
        canFork={true}
        onFork={onFork}
        canRevert={true}
        onRevert={onRevert}
      />
    )

    const revert = getByRole('button', { name: '撤销' })
    const fork = getByRole('button', { name: '分叉' })
    expect(revert).toBeEnabled()
    expect(revert).toHaveAttribute('type', 'button')
    expect(revert).toHaveAttribute('title', '撤销到此消息之前；不回滚文件')
    expect(revert.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(revert.parentElement).toBe(fork.parentElement)
    expect(revert.parentElement).toHaveClass('message-actions')
    fireEvent.click(revert)
    expect(onRevert).toHaveBeenCalledExactlyOnceWith('user-entry-6')
    expect(onFork).not.toHaveBeenCalled()

    expect(fork).toHaveAttribute('title', '从此消息分叉新分支')
    fireEvent.click(fork)
    expect(onFork).toHaveBeenCalledExactlyOnceWith('user-entry-6')
    expect(onRevert).toHaveBeenCalledTimes(1)
  })

  it.each([false, undefined])('blocks undo when canRevert is %s without blocking forks', (canRevert) => {
    const onRevert = vi.fn()
    const onFork = vi.fn()
    const { getByRole } = render(
      <ChatMessage
        item={persistedUserMessage}
        canFork={true}
        onFork={onFork}
        canRevert={canRevert}
        onRevert={onRevert}
        revertDisabledReason="会话运行中，暂不可撤销"
      />
    )

    const revert = getByRole('button', { name: '撤销' })
    expect(revert).toBeDisabled()
    expect(revert).toHaveAttribute('title', '会话运行中，暂不可撤销')
    fireEvent.click(revert)
    expect(onRevert).not.toHaveBeenCalled()
    fireEvent.click(getByRole('button', { name: '分叉' }))
    expect(onFork).toHaveBeenCalledExactlyOnceWith('user-entry-6')
  })

  it.each([
    { label: 'an optimistic user message', item: { ...persistedUserMessage, entryId: undefined } },
    {
      label: 'an assistant message with a persisted entry ID',
      item: {
        kind: 'assistant' as const,
        id: 7,
        entryId: 'assistant-entry-7',
        text: '助手回复',
        thinking: '',
        streaming: false
      }
    }
  ])('does not expose message undo or forks for $label', ({ item }) => {
    const { queryByRole } = render(
      <ChatMessage item={item} canFork={true} onFork={vi.fn()} canRevert={true} onRevert={vi.fn()} />
    )

    expect(queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
    expect(queryByRole('button', { name: '分叉' })).not.toBeInTheDocument()
  })

  it('keeps message and fork DOM stable when undo becomes available', () => {
    const onRevert = vi.fn()
    const props = { item: persistedUserMessage, canFork: true, onFork: vi.fn(), canRevert: true }
    const { container, getByRole, queryByRole, rerender } = render(<ChatMessage {...props} />)
    const row = container.querySelector('.row-user')
    const bubble = container.querySelector('.bubble-user')
    const content = container.querySelector('.bubble-content')
    const fork = getByRole('button', { name: '分叉' })
    expect(queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
    fork.focus()

    rerender(<ChatMessage {...props} onRevert={onRevert} canRevert={false} />)
    const revert = getByRole('button', { name: '撤销' })
    expect(revert).toBeDisabled()
    expect(revert).toHaveAttribute('title', '撤销到此消息之前；不回滚文件')
    expect(container.querySelector('.row-user')).toBe(row)
    expect(container.querySelector('.bubble-user')).toBe(bubble)
    expect(container.querySelector('.bubble-content')).toBe(content)
    expect(bubble).toHaveClass('screen-text-reveal-line-history')
    expect(getByRole('button', { name: '分叉' })).toBe(fork)
    expect(fork).toHaveFocus()

    rerender(<ChatMessage {...props} canFork={false} onRevert={onRevert} canRevert={true} />)
    expect(getByRole('button', { name: '撤销' })).toBe(revert)
    expect(container.querySelector('.bubble-content')).toBe(content)
    expect(queryByRole('button', { name: '分叉' })).not.toBeInTheDocument()
    expect(revert).toBeEnabled()
    revert.focus()
    expect(revert).toHaveFocus()
    fireEvent.click(revert)
    expect(onRevert).toHaveBeenCalledExactlyOnceWith('user-entry-6')
  })

  it('passes message undo props through the timeline without reusing checkpoint undo', () => {
    const onRevert = vi.fn()
    const onUndo = vi.fn()
    const props: ChatTimelineProps = {
      scrollRef: createRef<HTMLDivElement>(),
      onScroll: vi.fn(),
      timeline: [persistedUserMessage],
      timelineLoading: false,
      busy: false,
      starting: false,
      hasSessions: true,
      canFork: true,
      onFork: vi.fn(),
      canRevert: true,
      onRevert,
      agentActivity: false,
      workingStatus: { label: '' },
      latestRunChanges: [{ path: '/project/file.ts', kind: 'edit', additions: 1, deletions: 0 }],
      workspaceChanges: true,
      runCheckpoint: {
        id: 'checkpoint-1',
        cwd: '/project',
        createdAt: 1,
        state: 'ready',
        hasChanges: true,
        changedFileCount: 1
      },
      rollbackBusy: false,
      rollbackError: '',
      onUndo,
      onReview: vi.fn(),
      onSelectChange: vi.fn()
    }
    const { getByRole, rerender } = render(<ChatTimeline {...props} />)

    fireEvent.click(getByRole('button', { name: '撤销' }))
    expect(onRevert).toHaveBeenCalledExactlyOnceWith('user-entry-6')
    expect(onUndo).not.toHaveBeenCalled()
    const checkpointUndo = getByRole('button', { name: '撤销本轮' })
    expect(checkpointUndo).toBeEnabled()
    fireEvent.click(checkpointUndo)
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(onRevert).toHaveBeenCalledTimes(1)

    rerender(<ChatTimeline {...props} canRevert={false} revertDisabledReason="正在切换会话" />)
    const revert = getByRole('button', { name: '撤销' })
    expect(revert).toBeDisabled()
    expect(revert).toHaveAttribute('title', '正在切换会话')
    fireEvent.click(revert)
    expect(onRevert).toHaveBeenCalledTimes(1)
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(getByRole('button', { name: '撤销本轮' })).toBe(checkpointUndo)
    expect(checkpointUndo).toBeEnabled()
  })

  it('mounts an empty polite announcer separately from the visible error summary and untouched details', () => {
    vi.useFakeTimers()
    const raw = 'HTTP 429: rate limit exceeded\nrequest_id: req-123  '
    const { container, getByRole, getByText } = render(
      <ChatMessage
        item={{
          kind: 'assistant',
          id: 8,
          text: '',
          thinking: '',
          streaming: false,
          live: true,
          error: raw
        }}
        canFork={false}
      />
    )

    const card = container.querySelector('.bubble-error')
    const summary = container.querySelector('.bubble-error-summary')
    const announcement = getByRole('status')
    const details = getByText('技术详情').closest('details')
    const rawDetails = details?.querySelector('pre')

    expect(card).toHaveAttribute('data-error-category', 'rate-limit')
    expect(summary).not.toHaveAttribute('role')
    expect(summary).not.toHaveAttribute('aria-live')
    expect(summary).not.toHaveAttribute('aria-atomic')
    expect(summary).not.toHaveAttribute('aria-hidden')
    expect(summary).not.toHaveAttribute('hidden')
    expect(summary).not.toHaveClass('bubble-error-announcement')
    expect(summary).toHaveTextContent('请求过于频繁')
    expect(summary).toHaveTextContent('请稍后重试，或切换模型/提供商。')
    expect(summary).not.toHaveTextContent(raw)
    expect(details).not.toHaveAttribute('open')
    expect(rawDetails?.textContent).toBe(raw)
    expect(rawDetails?.querySelector('[data-screen-reveal-character]')).not.toBeInTheDocument()
    expect(rawDetails?.querySelector('.screen-text-reveal-live')).not.toBeInTheDocument()
    expect(summary).not.toContainElement(rawDetails ?? null)
    expect(summary).not.toContainElement(announcement)
    expect(container.querySelectorAll('.bubble-error-message .screen-text-reveal-live').length).toBeGreaterThan(0)
    expect(announcement).toHaveClass('bubble-error-announcement')
    expect(announcement).toHaveAttribute('aria-live', 'polite')
    expect(announcement).toHaveAttribute('aria-atomic', 'true')
    expect(announcement).not.toHaveAttribute('aria-hidden')
    expect(announcement).toBeEmptyDOMElement()

    act(() => vi.advanceTimersByTime(0))

    expect(getByRole('status')).toBe(announcement)
    expect(announcement.textContent).toBe('请求过于频繁。请稍后重试，或切换模型/提供商。')
    expect(announcement.childNodes).toHaveLength(1)
    expect(announcement.querySelector('*')).not.toBeInTheDocument()
    expect(announcement).not.toHaveTextContent('request_id')
    expect(announcement).not.toContainElement(rawDetails ?? null)
    expect(details).not.toHaveAttribute('open')
  })

  it('keeps a long diagnostic plain and does not reannounce same-category raw, detail or unrelated text updates', () => {
    vi.useFakeTimers()
    const describeError = vi.spyOn(modelError, 'describeModelError')
    const raw = '\tHTTP 429: rate limit exceeded\r\n<diagnostic>&"中文" '
      + 'trace='.repeat(2048) + '\r\nrequest_id: req-long\t  \n'
    const item = {
      kind: 'assistant' as const,
      id: 11,
      text: '',
      thinking: '',
      streaming: false,
      live: true,
      error: raw
    }
    const { container, getByRole, rerender } = render(<ChatMessage item={item} canFork={false} />)
    const summary = container.querySelector('.bubble-error-summary')
    const announcement = getByRole('status')
    const message = summary?.querySelector('.bubble-error-message')
    const messageNodes = Array.from(message?.childNodes ?? [])
    const details = container.querySelector<HTMLDetailsElement>('.bubble-error-details')
    const rawDetails = details?.querySelector('pre')

    expect(describeError).toHaveBeenCalledExactlyOnceWith(raw)
    expect(messageNodes.length).toBeGreaterThan(1)
    expect(details).not.toHaveAttribute('open')
    expect(rawDetails?.textContent).toBe(raw)
    expect(rawDetails?.childNodes).toHaveLength(1)
    expect(rawDetails?.querySelector('*')).not.toBeInTheDocument()
    expect(summary).not.toHaveTextContent('trace=')
    expect(announcement).toBeEmptyDOMElement()
    act(() => vi.advanceTimersByTime(0))
    const announcementNode = announcement.firstChild
    const announcementText = announcement.textContent
    expect(announcementText).toBe('请求过于频繁。请稍后重试，或切换模型/提供商。')
    if (details) details.open = true
    act(() => vi.advanceTimersByTime(0))
    expect(announcement.firstChild).toBe(announcementNode)
    expect(announcement.textContent).toBe(announcementText)
    const scheduleAnnouncement = vi.spyOn(window, 'setTimeout')

    rerender(<ChatMessage item={{ ...item, text: '部分回复仍在更新', thinking: '补充说明' }} canFork={false} />)
    act(() => vi.advanceTimersByTime(0))
    expect(describeError).toHaveBeenCalledTimes(1)
    expect(getByRole('status')).toBe(announcement)
    expect(announcement.firstChild).toBe(announcementNode)
    expect(announcement.textContent).toBe(announcementText)
    // Nonzero fade cleanup timers are independent of accessibility announcements.
    expect(scheduleAnnouncement.mock.calls.filter(([, delay]) => delay === 0)).toHaveLength(0)
    expect(container.querySelector('.bubble-error-summary')).toBe(summary)
    expect(message?.childNodes).toHaveLength(messageNodes.length)
    messageNodes.forEach((node, index) => expect(message?.childNodes[index]).toBe(node))
    expect(container.querySelector('.bubble-error-details')).toBe(details)
    expect(details).toHaveAttribute('open')

    const revisedRaw = raw + 'additional provider detail'
    rerender(<ChatMessage item={{ ...item, error: revisedRaw }} canFork={false} />)
    act(() => vi.advanceTimersByTime(0))
    expect(describeError).toHaveBeenCalledTimes(2)
    expect(describeError).toHaveBeenLastCalledWith(revisedRaw)
    expect(rawDetails?.textContent).toBe(revisedRaw)
    expect(rawDetails?.childNodes).toHaveLength(1)
    expect(getByRole('status')).toBe(announcement)
    expect(announcement.firstChild).toBe(announcementNode)
    expect(announcement.textContent).toBe(announcementText)
    expect(scheduleAnnouncement.mock.calls.filter(([, delay]) => delay === 0)).toHaveLength(0)
    expect(message?.childNodes).toHaveLength(messageNodes.length)
    messageNodes.forEach((node, index) => expect(message?.childNodes[index]).toBe(node))
    expect(details).toHaveAttribute('open')

    const authenticationError = 'HTTP 401: invalid API key\nrequest_id: req-auth  '
    rerender(<ChatMessage item={{ ...item, error: authenticationError }} canFork={false} />)
    expect(describeError).toHaveBeenCalledTimes(3)
    expect(summary).toHaveTextContent('模型认证失败')
    expect(summary).toHaveTextContent('请在设置中重新登录，或检查 API Key 后重试。')
    expect(announcement.textContent).toBe(announcementText)
    expect(scheduleAnnouncement.mock.calls.filter(([, delay]) => delay === 0)).toHaveLength(1)
    act(() => vi.advanceTimersByTime(0))
    expect(getByRole('status')).toBe(announcement)
    expect(announcement.textContent).toBe('模型认证失败。请在设置中重新登录，或检查 API Key 后重试。')
    expect(announcement.querySelector('*')).not.toBeInTheDocument()
    expect(rawDetails?.textContent).toBe(authenticationError)
    expect(rawDetails?.querySelector('*')).not.toBeInTheDocument()
    expect(container.querySelector('.bubble-error-details')).toBe(details)
    expect(details).toHaveAttribute('open')
  })

  it('honors noReveal for a live error while retaining its deferred polite announcement', () => {
    vi.useFakeTimers()
    const raw = 'HTTP 503: service unavailable'
    const { container, getByRole } = render(
      <ChatMessage
        item={{
          kind: 'assistant',
          id: 12,
          text: '',
          thinking: '',
          streaming: false,
          live: true,
          noReveal: true,
          error: raw
        }}
        canFork={false}
      />
    )

    const announcement = getByRole('status')
    expect(announcement).toHaveAttribute('aria-live', 'polite')
    expect(announcement).toBeEmptyDOMElement()
    act(() => vi.advanceTimersByTime(0))
    expect(announcement).toHaveTextContent('模型服务暂时不可用')
    expect(announcement.querySelector('*')).not.toBeInTheDocument()
    expect(container.querySelector('.bubble-assistant')).not.toHaveClass('screen-text-reveal-line')
    expect(container.querySelectorAll('.bubble-error .screen-text-reveal-line, .bubble-error [data-screen-reveal-character]')).toHaveLength(0)
    expect(container.querySelector('.bubble-error-details pre')?.textContent).toBe(raw)
  })

  it('announces the compaction context label without including or rewriting its technical detail', () => {
    vi.useFakeTimers()
    const raw = 'summarizer unavailable'
    const { container, getByRole } = render(
      <ChatMessage
        item={{
          kind: 'assistant',
          id: 10,
          text: '',
          thinking: '',
          streaming: false,
          live: true,
          error: raw,
          errorContext: 'compaction'
        }}
        canFork={false}
      />
    )

    expect(container.querySelector('.bubble-error-context')).toHaveTextContent('上下文压缩失败')
    expect(container.querySelector('.bubble-error-details pre')?.textContent).toBe(raw)
    const announcement = getByRole('status')
    expect(announcement).toBeEmptyDOMElement()
    act(() => vi.advanceTimersByTime(0))
    expect(announcement.textContent).toBe('模型请求失败。请稍后重试；若持续出现，请检查模型设置或切换模型。 上下文压缩失败。')
    expect(announcement.childNodes).toHaveLength(1)
    expect(announcement.querySelector('*')).not.toBeInTheDocument()
    expect(announcement).not.toHaveTextContent(raw)
  })

  it.each([false, true])('keeps historical errors silent even with a cached live flag (noReveal: %s)', (noReveal) => {
    vi.useFakeTimers()
    const { container } = render(
      <ChatMessage
        item={{
          kind: 'assistant',
          id: 9,
          text: '',
          thinking: '',
          streaming: false,
          live: true,
          historical: true,
          noReveal,
          error: 'Stored provider failure'
        }}
        canFork={false}
      />
    )

    const summary = container.querySelector('.bubble-error-summary')
    expect(summary).toHaveTextContent('模型请求失败')
    expect(summary).not.toHaveAttribute('role')
    expect(summary).not.toHaveAttribute('aria-live')
    expect(summary).not.toHaveAttribute('aria-atomic')
    expect(container.querySelector('.bubble-error-announcement')).not.toBeInTheDocument()
    expect(container.querySelector('.bubble-error [role="status"]')).not.toBeInTheDocument()
    expect(container.querySelector('.bubble-error [aria-live]')).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
    expect(container.querySelectorAll('.bubble-error-message .screen-text-reveal-line-history')).toHaveLength(noReveal ? 0 : 1)
    expect(container.querySelectorAll('.bubble-error [data-screen-reveal-character]')).toHaveLength(0)
  })

  it.each([false, undefined])('does not register an announcer for non-live errors (live: %s)', (live) => {
    vi.useFakeTimers()
    const { container, queryByRole } = render(
      <ChatMessage
        item={{
          kind: 'assistant',
          id: 13,
          text: '',
          thinking: '',
          streaming: false,
          live,
          error: 'HTTP 429: too many requests'
        }}
        canFork={false}
      />
    )

    expect(container.querySelector('.bubble-error-summary')).toHaveTextContent('请求过于频繁')
    expect(container.querySelector('.bubble-error-details')).not.toHaveAttribute('open')
    expect(container.querySelector('.bubble-error-announcement')).not.toBeInTheDocument()
    expect(container.querySelector('.bubble-error [aria-live]')).not.toBeInTheDocument()
    expect(queryByRole('status')).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['history', 'no-live', 'unmount'] as const)('cancels a pending announcement on %s', (transition) => {
    vi.useFakeTimers()
    const scheduleAnnouncement = vi.spyOn(window, 'setTimeout')
    const cancelAnnouncement = vi.spyOn(window, 'clearTimeout')
    const item = {
      kind: 'assistant' as const,
      id: 14,
      text: '',
      thinking: '',
      streaming: false,
      live: true,
      noReveal: true,
      error: 'HTTP 429: too many requests'
    }
    const { container, getByRole, queryByRole, rerender, unmount } = render(<ChatMessage item={item} canFork={false} />)
    const announcement = getByRole('status')
    const summary = container.querySelector('.bubble-error-summary')
    const details = container.querySelector('.bubble-error-details')
    expect(announcement).toBeEmptyDOMElement()
    expect(scheduleAnnouncement).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 0)
    const timeout = scheduleAnnouncement.mock.results[0]?.value
    expect(vi.getTimerCount()).toBe(1)

    if (transition === 'unmount') {
      unmount()
    } else {
      rerender(
        <ChatMessage
          item={{ ...item, historical: transition === 'history', live: transition !== 'no-live' }}
          canFork={false}
        />
      )
      expect(container.querySelector('.bubble-error-summary')).toBe(summary)
      expect(container.querySelector('.bubble-error-details')).toBe(details)
    }

    expect(queryByRole('status')).not.toBeInTheDocument()
    expect(container.querySelector('.bubble-error [aria-live]')).not.toBeInTheDocument()
    expect(cancelAnnouncement).toHaveBeenCalledExactlyOnceWith(timeout)
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(0))
    expect(announcement).not.toBeInTheDocument()
    expect(announcement).toBeEmptyDOMElement()

    if (transition !== 'unmount') {
      rerender(<ChatMessage item={item} canFork={false} />)
      const resumedAnnouncement = getByRole('status')
      expect(resumedAnnouncement).not.toBe(announcement)
      expect(resumedAnnouncement).toBeEmptyDOMElement()
      act(() => vi.advanceTimersByTime(0))
      expect(resumedAnnouncement.textContent).toBe('请求过于频繁。请稍后重试，或切换模型/提供商。')
    }
  })

  it('bounds and wraps diagnostics with accessible hiding, theme colors and reduced motion (source contract)', () => {
    const css = readFileSync('src/renderer/src/styles/chat.css', 'utf8')
    const cardRule = css.match(/\.bubble-error\s*\{([^}]*)\}/)?.[1] ?? ''
    const announcementRule = css.match(/\.bubble-error-announcement\s*\{([^}]*)\}/)?.[1] ?? ''
    const rawRule = css.match(/\.bubble-error-details pre\s*\{([^}]*)\}/)?.[1] ?? ''
    const reducedMotion = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(cardRule).toContain('min-width: 0')
    expect(cardRule).toContain('max-width: 100%')
    expect(cardRule).toContain('overflow-wrap: anywhere')
    expect(cardRule).toContain('background: var(--surface-tint)')
    expect(cardRule).toContain('color: var(--fg)')
    expect(cardRule).toContain('border-left: 3px solid var(--danger)')
    expect(announcementRule).toContain('position: absolute')
    expect(announcementRule).toContain('width: 1px')
    expect(announcementRule).toContain('height: 1px')
    expect(announcementRule).toContain('overflow: hidden')
    expect(announcementRule).toContain('clip-path: inset(50%)')
    expect(announcementRule).not.toMatch(/display:\s*none|visibility:\s*hidden/)
    expect(rawRule).toContain('box-sizing: border-box')
    expect(rawRule).toContain('max-width: 100%')
    expect(rawRule).toContain('max-height: 240px')
    expect(rawRule).toContain('overflow: auto')
    expect(rawRule).toContain('overflow-wrap: anywhere')
    expect(rawRule).toContain('white-space: pre-wrap')
    expect(rawRule).toContain('background: var(--code-bg)')
    expect(rawRule).toContain('color: var(--fg-dim)')
    expect(css).toMatch(/@media \(forced-colors: active\)\s*\{[\s\S]*?\.bubble-error\s*\{[^}]*background: Canvas;/)
    expect(reducedMotion).toContain('.bubble-assistant.screen-text-reveal-line:has(.bubble-error)')
    expect(reducedMotion).toContain('.bubble-error .screen-text-reveal-line[data-line-reveal-ready="true"]')
    expect(reducedMotion).toContain('.bubble-error .screen-text-reveal-character')
    expect(reducedMotion).toContain('opacity: 1')
    expect(reducedMotion).toContain('animation: none')
  })

  it('streams assistant text without a simulated terminal block cursor', () => {
    const { container } = render(
      <ChatMessage
        item={{
          kind: 'assistant',
          id: 1,
          text: '正在生成回复',
          thinking: '',
          streaming: true,
          live: true
        }}
        canFork={false}
      />
    )

    expect(container.querySelector('.markdown')).toHaveTextContent('正在生成回复')
    expect(container.querySelectorAll('.markdown .screen-text-reveal-line-live')).toHaveLength(1)
    expect(container.querySelector('.caret')).not.toBeInTheDocument()
  })

  it('retains unfinished Markdown fades and original delays across rapid tokens without restarting the prefix', () => {
    vi.useFakeTimers()
    const item = { kind: 'assistant' as const, id: 90, text: 'abc', thinking: '', streaming: true, live: true }
    const view = render(<ChatMessage item={item} canFork={false} />)
    const characters = view.container.querySelectorAll<HTMLElement>('.markdown .screen-text-reveal-live')
    expect(characters).toHaveLength(3)
    expect(characters[1].style.getPropertyValue('--screen-text-reveal-delay')).toBe('2.4ms')
    view.rerender(<ChatMessage item={{ ...item, text: 'abcde' }} canFork={false} />)
    const suffix = view.container.querySelectorAll<HTMLElement>('.markdown .screen-text-reveal-live')
    expect(Array.from(suffix, (node) => node.textContent).join('')).toBe('abcde')
    expect(suffix[0]).toBe(characters[0])
    expect(suffix[1]).toBe(characters[1])
    expect(suffix[1].style.getPropertyValue('--screen-text-reveal-delay')).toBe('2.4ms')
    expect(suffix[3].style.getPropertyValue('--screen-text-reveal-delay')).toBe('0ms')
    expect(suffix[4].style.getPropertyValue('--screen-text-reveal-delay')).toBe('2.4ms')
    act(() => vi.advanceTimersByTime(SCREEN_TEXT_REVEAL_LIVE_DURATION_MS + SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS + 10))
    expect(view.container.querySelector('.markdown .screen-text-reveal-live')).toBeNull()
    view.rerender(<ChatMessage item={{ ...item, text: 'abcdef' }} canFork={false} />)
    expect(view.container.querySelector('.markdown .screen-text-reveal-live')).toHaveTextContent('f')
  })

  it('preserves completed-line fades through a new line and streaming settlement, then cleans up without losing text', () => {
    vi.useFakeTimers()
    const view = render(<Markdown text="abc" revealMode="live" />)
    const original = view.container.querySelector('.screen-text-reveal-live')
    act(() => vi.advanceTimersByTime(10))
    view.rerender(<Markdown text={'abc\ndef'} revealMode="live" />)
    expect(view.container.querySelector('.screen-text-reveal-live')).toBe(original)
    expect(view.container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(6)
    view.rerender(<Markdown text={'abc\ndef'} />)
    expect(view.container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(6)
    expect(view.container).toHaveTextContent('abcdef')
    act(() => vi.advanceTimersByTime(SCREEN_TEXT_REVEAL_LIVE_DURATION_MS + SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS + 10))
    expect(view.container.querySelector('.screen-text-reveal-live')).toBeNull()
    expect(view.container).toHaveTextContent(/abc\s*def/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds pending Markdown fades and uses one cleanup timer with unmount cleanup', () => {
    vi.useFakeTimers()
    const view = render(<Markdown text={'x'.repeat(5000)} revealMode="live" />)
    expect(view.container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(4096)
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(SCREEN_TEXT_REVEAL_LIVE_DURATION_MS + SCREEN_TEXT_REVEAL_LIVE_MAX_DELAY_MS + SCREEN_TEXT_REVEAL_CLEANUP_GRACE_MS + 10))
    expect(view.container.querySelector('.screen-text-reveal-live')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    view.rerender(<Markdown text={'x'.repeat(5000) + 'y'} revealMode="live" />)
    expect(view.container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resets fade windows on replacement and never starts new read-only or reduced-motion fades', () => {
    vi.useFakeTimers()
    const view = render(<Markdown text="old" revealMode="live" />)
    view.rerender(<Markdown text="new" revealMode="live" />)
    expect(Array.from(view.container.querySelectorAll('.screen-text-reveal-live'), (node) => node.textContent).join('')).toBe('new')
    view.rerender(<Markdown text="new suffix" revealMode="live" readOnly />)
    expect(Array.from(view.container.querySelectorAll('.screen-text-reveal-live'), (node) => node.textContent).join('')).toBe('new')
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    view.rerender(<Markdown text="new suffix more" revealMode="live" />)
    expect(Array.from(view.container.querySelectorAll('.screen-text-reveal-live'), (node) => node.textContent).join('')).toBe('new')
  })

  it('keeps the restored running bubble fade while animating only new thinking and staying silent', () => {
    const item = { kind: 'assistant' as const, id: 35, text: '恢复的输出', thinking: '原思考',
      live: true, historical: true, noReveal: false, streaming: true, error: '恢复的错误' }
    const { container, rerender } = render(<ChatMessage item={item} canFork={false} />)
    const bubble = container.querySelector('.bubble-assistant')
    expect(bubble).toHaveClass('screen-text-reveal-line-history')
    expect(container.querySelector('.bubble-error [aria-live]')).not.toBeInTheDocument()
    rerender(<ChatMessage item={{ ...item, text: '恢复的输出新增', thinking: '原思考新增' }} canFork={false} />)
    expect(container.querySelector('.bubble-assistant')).toBe(bubble)
    expect(container.querySelector('.thinking pre')).toHaveTextContent('原思考新增')
    // The original three characters are still fading; the two new ones join
    // without prematurely cancelling/restarting that original window.
    expect(container.querySelectorAll('.thinking .screen-text-reveal-live')).toHaveLength(5)
    expect(container.querySelector('.bubble-error [aria-live]')).not.toBeInTheDocument()
  })

  it('arms a historical row after the lazy message component mounts', () => {
    const { container } = render(
      <div className="chat-scroll">
        <ChatMessage
          item={{
            kind: 'assistant',
            id: 3,
            text: '延迟加载后仍应显示',
            thinking: '',
            streaming: false,
            historical: true
          }}
          canFork={false}
        />
      </div>
    )

    expect(container.querySelector('.markdown')).toHaveTextContent('延迟加载后仍应显示')
    expect(container.querySelector('.history-reveal')).toBeInTheDocument()
  })

  it('reveals live thinking text independently from the assistant answer', () => {
    const { container } = render(
      <ChatMessage
        item={{
          kind: 'assistant',
          id: 2,
          text: '',
          thinking: '分析工具调用',
          streaming: true,
          live: true
        }}
        canFork={false}
      />
    )

    expect(container.querySelector('.row-assistant-thinking-only')).toBeInTheDocument()
    expect(container.querySelectorAll('.screen-text-reveal-live')).toHaveLength(6)
  })

  it('fades the assistant bubble in together with its first line', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    resetLineRevealClock()
    takeLineRevealSlot() // occupy an earlier slot so the line delay is non-zero
    const { container } = render(
      <ChatMessage
        item={{
          kind: 'assistant',
          id: 5,
          text: '第一行\n第二行',
          thinking: '',
          streaming: false,
          historical: true
        }}
        canFork={false}
      />
    )
    // History lines wait for the settle scan, which assigns DOM-order delays
    // and lets the bubble copy its first line's slot.
    assignPendingLineDelays(container)

    const bubble = container.querySelector<HTMLElement>('.bubble-assistant')
    const firstLine = container.querySelector<HTMLElement>('.markdown .screen-text-reveal-line')
    expect(bubble?.className).toContain('screen-text-reveal-line')
    expect(firstLine).not.toBeNull()
    const lineDelay = firstLine?.style.getPropertyValue('--screen-text-reveal-delay')
    expect(lineDelay).toBe('40ms')
    expect(bubble?.style.getPropertyValue('--screen-text-reveal-delay')).toBe('20ms')
    vi.restoreAllMocks()
  })
})
