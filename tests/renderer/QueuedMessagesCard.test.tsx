// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessagesCard } from '../../src/renderer/src/features/session/QueuedMessagesCard'

beforeEach(() => window.localStorage.clear())

describe('QueuedMessagesCard', () => {
  it('keeps an empty paused queue compact without a continue action or explanatory messages', () => {
    const { container } = render(<QueuedMessagesCard sessionKey="paused-empty" queuePause={{ paused: true, revision: 2,
      reason: '提问等待超时', pausedRunId: 'real-run' }} />)
    expect(screen.queryByText('提问等待超时')).not.toBeInTheDocument()
    expect(screen.queryByText('手动发送只处理所选消息，不解除其余队列的暂停。')).not.toBeInTheDocument()
    expect(container.querySelector<HTMLElement>('.queue-panel')?.style.getPropertyValue('--task-panel-expanded-height')).toBe('52px')
    expect(screen.getByText('已暂停，等待处理当前任务')).toBeInTheDocument()
    expect(screen.getByText('0 条')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '继续当前任务' })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('does not offer a continue action or auto-send actual items even with a paused run identity', () => {
    const send = vi.fn()
    const { container } = render(<QueuedMessagesCard sessionKey="paused" followUp={['下一任务']} queuePause={{ paused: true, revision: 1,
      pausedRunId: 'real-run' }} onSendItem={send} />)
    expect(container.querySelector<HTMLElement>('.queue-panel')?.style.getPropertyValue('--task-panel-expanded-height')).toBe('102px')
    expect(screen.queryByRole('button', { name: '继续当前任务' })).not.toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
    expect(screen.queryByText('本轮未确认正常完成，排队消息不会自动发送。')).not.toBeInTheDocument()
    expect(screen.getByText('下一任务')).toBeInTheDocument()
    expect(screen.getByText('已暂停，等待处理当前任务')).toBeInTheDocument()
  })

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
        queuePause={{ paused: true, revision: 1, pausedRunId: 'real-run' }}
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

  it('keeps direct sending disabled without a handler and while an item is in flight', async () => {
    let finishSend!: () => void
    const send = vi.fn(() => new Promise<void>((resolve) => { finishSend = resolve }))
    const props = {
      sessionKey: 'paused-send',
      steering: ['原生插入'],
      followUp: ['原生稍后', '本地稍后'],
      nativeFollowUpCount: 1,
      queuePause: { paused: true, revision: 1, pausedRunId: 'real-run' }
    }
    const { rerender } = render(<QueuedMessagesCard {...props} />)
    expect(screen.getAllByRole('button', { name: /直接发送第/ }).every((button) => button.hasAttribute('disabled'))).toBe(true)

    rerender(<QueuedMessagesCard {...props} onSendItem={send} />)
    fireEvent.click(screen.getByRole('button', { name: '直接发送第 2 条排队消息' }))
    expect(send).toHaveBeenCalledExactlyOnceWith('followUp', 0)
    expect(screen.getAllByRole('button', { name: /直接发送第/ }).every((button) => button.hasAttribute('disabled'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '直接发送第 3 条排队消息' }))
    expect(send).toHaveBeenCalledTimes(1)

    await act(async () => { finishSend() })
    expect(screen.getAllByRole('button', { name: /直接发送第/ }).every((button) => !button.hasAttribute('disabled'))).toBe(true)
    expect(screen.getByText('已暂停，等待处理当前任务')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '继续当前任务' })).not.toBeInTheDocument()
  })

  it('exposes edit and remove actions only for local follow-up items', () => {
    const onEditItem = vi.fn()
    const onRemoveItem = vi.fn()
    render(
      <QueuedMessagesCard
        sessionKey="session-edit"
        queuePause={{ paused: true, revision: 1, pausedRunId: 'real-run' }}
        steering={['原生插入']}
        followUp={['原生稍后', '本地稍后']}
        nativeFollowUpCount={1}
        followUpRunIds={[null, 'local-real-id']}
        onEditItem={onEditItem}
        onRemoveItem={onRemoveItem}
      />
    )

    // steering 项和 Pi 原生 followUp 项不可编辑/删除，本地项两个按钮都在
    expect(screen.getAllByRole('button', { name: /编辑第/ })).toHaveLength(3)
    expect(screen.getByRole('button', { name: '编辑第 1 条排队消息' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '编辑第 2 条排队消息' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: /删除第/ })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '编辑第 3 条排队消息' }))
    expect(onEditItem).toHaveBeenCalledWith(expect.objectContaining({ kind: 'followUp', index: 1, text: '本地稍后', runId: 'local-real-id' }))

    fireEvent.click(screen.getByRole('button', { name: '删除第 3 条排队消息' }))
    expect(onRemoveItem).toHaveBeenCalledWith('followUp', 1)
  })

  it('does not guess an edit identity from local position or identical text', () => {
    const edit = vi.fn()
    const { rerender } = render(<QueuedMessagesCard sessionKey="same-text"
      followUp={['same', 'same']} followUpRunIds={['first', 'second']} onEditItem={edit} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑第 2 条排队消息' }))
    expect(edit).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'second' }))
    rerender(<QueuedMessagesCard sessionKey="same-text" followUp={['same']}
      followUpRunIds={['second']} onEditItem={edit} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑第 1 条排队消息' }))
    expect(edit).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'second', index: 0 }))
    rerender(<QueuedMessagesCard sessionKey="same-text" followUp={['same']} onEditItem={edit} />)
    expect(screen.getByRole('button', { name: '编辑第 1 条排队消息' })).toBeDisabled()
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
