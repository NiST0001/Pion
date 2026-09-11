// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
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
