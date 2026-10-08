// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as modelError from '../../src/renderer/src/agent/modelError'
import { ChatMessage } from '../../src/renderer/src/features/chat/ChatMessage'
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
    vi.useRealTimers()
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
    expect(scheduleAnnouncement).not.toHaveBeenCalled()
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
    expect(scheduleAnnouncement).not.toHaveBeenCalled()
    expect(message?.childNodes).toHaveLength(messageNodes.length)
    messageNodes.forEach((node, index) => expect(message?.childNodes[index]).toBe(node))
    expect(details).toHaveAttribute('open')

    const authenticationError = 'HTTP 401: invalid API key\nrequest_id: req-auth  '
    rerender(<ChatMessage item={{ ...item, error: authenticationError }} canFork={false} />)
    expect(describeError).toHaveBeenCalledTimes(3)
    expect(summary).toHaveTextContent('模型认证失败')
    expect(summary).toHaveTextContent('请在设置中重新登录，或检查 API Key 后重试。')
    expect(announcement.textContent).toBe(announcementText)
    expect(scheduleAnnouncement).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 0)
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
    expect(container.querySelectorAll('.thinking .screen-text-reveal-live')).toHaveLength(2)
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
