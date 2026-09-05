// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessagesCard } from '../../src/renderer/src/features/session/QueuedMessagesCard'

beforeEach(() => window.localStorage.clear())

describe('QueuedMessagesCard', () => {
  it('shows steering and follow-up messages with their queue kind', () => {
    const { container } = render(
      <QueuedMessagesCard
        sessionKey="session-queue"
        steering={['先检查这个文件']}
        followUp={['完成当前任务后运行测试']}
      />
    )

    expect(screen.getByText('排队消息')).toBeInTheDocument()
    expect(screen.getByText('先检查这个文件')).toBeInTheDocument()
    expect(screen.getByText('完成当前任务后运行测试')).toBeInTheDocument()
    expect(container.querySelector('[data-queue-kind="steering"]')).toBeInTheDocument()
    expect(container.querySelector('[data-queue-kind="followUp"]')).toBeInTheDocument()
  })

  it('exposes a direct-send action for each queued message', () => {
    const onSendItem = vi.fn()
    render(
      <QueuedMessagesCard
        sessionKey="session-direct"
        steering={['插入当前运行']}
        followUp={['稍后继续']}
        onSendItem={onSendItem}
      />
    )

    const buttons = screen.getAllByRole('button', { name: /直接发送第/ })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    expect(onSendItem).toHaveBeenCalledWith('followUp', 0)
  })

  it('exposes edit and remove actions only for local follow-up items', () => {
    const onEditItem = vi.fn()
    const onRemoveItem = vi.fn()
    render(
      <QueuedMessagesCard
        sessionKey="session-edit"
        steering={['原生插入']}
        followUp={['原生稍后', '本地稍后']}
        nativeFollowUpCount={1}
        onEditItem={onEditItem}
        onRemoveItem={onRemoveItem}
      />
    )

    // steering 项和 Pi 原生 followUp 项不可编辑/删除，本地项两个按钮都在
    expect(screen.getAllByRole('button', { name: /编辑第/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /删除第/ })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '编辑第 3 条排队消息' }))
    expect(onEditItem).toHaveBeenCalledWith(expect.objectContaining({ kind: 'followUp', index: 1, text: '本地稍后' }))

    fireEvent.click(screen.getByRole('button', { name: '删除第 3 条排队消息' }))
    expect(onRemoveItem).toHaveBeenCalledWith('followUp', 1)
  })

  it('can collapse the message list and persists the session preference', () => {
    render(
      <QueuedMessagesCard
        sessionKey="session-collapse"
        followUp={['等待当前运行完成']}
      />
    )

    const header = screen.getByRole('button', { name: '收起排队消息' })
    expect(header).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(header)
    expect(screen.getByRole('button', { name: '展开排队消息' })).toHaveAttribute('aria-expanded', 'false')
    expect(window.localStorage.getItem('pion:session-queue-panel-state:session-collapse')).toBe('false')
  })

  it('does not mount an empty queue', () => {
    const { container } = render(<QueuedMessagesCard sessionKey="session-empty" />)
    expect(container.querySelector('.queue-panel')).not.toBeInTheDocument()
  })
})
