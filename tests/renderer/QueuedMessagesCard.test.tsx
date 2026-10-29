// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessagesCard } from '../../src/renderer/src/features/session/QueuedMessagesCard'
import { QUEUE_ADMISSION_ERROR_MESSAGES, type QueuedMessageAdmissionError } from '../../src/shared/types'

beforeEach(() => window.localStorage.clear())

describe('QueuedMessagesCard', () => {
  it('shows waiting messages without auto-sending from the renderer', () => {
    const send = vi.fn()
    const { container } = render(<QueuedMessagesCard sessionKey="waiting" followUp={['下一任务']} followUpRunIds={['waiting-run']} onSendItem={send} />)
    expect(container.querySelector<HTMLElement>('.queue-panel')?.style.getPropertyValue('--task-panel-expanded-height')).toBe('102px')
    expect(screen.queryByRole('button', { name: '继续当前任务' })).not.toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
    expect(screen.queryByText('本轮未确认正常完成，排队消息不会自动发送。')).not.toBeInTheDocument()
    expect(screen.getByText('下一任务')).toBeInTheDocument()
    expect(screen.getByText('1 条')).toBeInTheDocument()
    expect(screen.queryByText('已暂停，等待处理当前任务')).not.toBeInTheDocument()
    expect(container.querySelector('.task-panel-caption')).toHaveTextContent('等待本轮完成')
  })

  it('shows steering and follow-up messages with their queue kind', () => {
    const { container } = render(
      <QueuedMessagesCard
        sessionKey="session-queue"
        steering={['先检查这个文件']}
        followUp={['完成当前任务后运行测试']}
        followUpRunIds={['follow-up-run']}
      />
    )

    expect(screen.getByText('排队消息')).toBeInTheDocument()
    expect(screen.getByText('先检查这个文件')).toBeInTheDocument()
    expect(screen.getByText('完成当前任务后运行测试')).toBeInTheDocument()
    expect(screen.getByText('1 条插入 · 1 条稍后')).toBeInTheDocument()
    expect(container.querySelector('[data-queue-kind="steering"]')).toBeInTheDocument()
    expect(container.querySelector('[data-queue-kind="followUp"]')).toBeInTheDocument()
  })

  it('allows direct-send only for an identified local follow-up', () => {
    const onSendItem = vi.fn()
    render(
      <QueuedMessagesCard
        sessionKey="session-direct"
        steering={['插入当前运行']}
        followUp={['稍后继续']}
        followUpRunIds={['direct-run']}
        onSendItem={onSendItem}
      />
    )

    const buttons = screen.getAllByRole('button', { name: /直接发送第/ })
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toBeDisabled()
    fireEvent.click(buttons[0])
    expect(onSendItem).not.toHaveBeenCalled()
    fireEvent.click(buttons[1])
    expect(onSendItem).toHaveBeenCalledWith('followUp', 0, 'direct-run')
  })

  it('keeps direct sending disabled without a handler and while an item is in flight', async () => {
    let finishSend!: () => void
    const send = vi.fn(() => new Promise<void>((resolve) => { finishSend = resolve }))
    const props = {
      sessionKey: 'direct-send',
      steering: ['原生插入'],
      followUp: ['原生稍后', '本地稍后'],
      followUpRunIds: [null, 'local-send-run'],
      nativeFollowUpCount: 1
    }
    const { container, rerender } = render(<QueuedMessagesCard {...props} />)
    expect(screen.getAllByRole('button', { name: /直接发送第/ }).every((button) => button.hasAttribute('disabled'))).toBe(true)

    rerender(<QueuedMessagesCard {...props} onSendItem={send} />)
    expect(screen.getByRole('button', { name: '直接发送第 2 条排队消息' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '直接发送第 3 条排队消息' }))
    expect(send).toHaveBeenCalledExactlyOnceWith('followUp', 1, 'local-send-run')
    expect(screen.getAllByRole('button', { name: /直接发送第/ }).every((button) => button.hasAttribute('disabled'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '直接发送第 3 条排队消息' }))
    expect(send).toHaveBeenCalledTimes(1)

    await act(async () => { finishSend() })
    expect(screen.getByRole('button', { name: '直接发送第 1 条排队消息' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '直接发送第 2 条排队消息' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '直接发送第 3 条排队消息' })).toBeEnabled()
    expect(screen.queryByText('已暂停，等待处理当前任务')).not.toBeInTheDocument()
    expect(container.querySelector('.task-panel-caption')).toHaveTextContent('1 条插入 · 2 条稍后')
    expect(screen.queryByRole('button', { name: '继续当前任务' })).not.toBeInTheDocument()
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
    expect(onRemoveItem).toHaveBeenCalledWith('followUp', 1, 'local-real-id')
  })

  it('retains the waiting caption, FIFO text, image references, identities and actions', async () => {
    const onEditItem = vi.fn()
    const onSendItem = vi.fn()
    const onRemoveItem = vi.fn()
    const originalText = '原始正文\n@"图像 1" @"图像 2"'
    const { container } = render(<QueuedMessagesCard sessionKey="queue-actions"
      followUp={[originalText, '下一项']} followUpRunIds={['image-run', 'next-run']}
      onEditItem={onEditItem} onSendItem={onSendItem} onRemoveItem={onRemoveItem} />)

    expect(screen.queryByText('已暂停，等待处理当前任务')).not.toBeInTheDocument()
    expect(container.querySelector('.task-panel-caption')).toHaveTextContent('等待本轮完成')
    expect(screen.getByText('排队消息')).toBeInTheDocument()
    expect(screen.getByText('2 条')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((item) => item.getAttribute('title'))).toEqual([originalText, '下一项'])
    expect(screen.getAllByRole('button', { name: /编辑第/ })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /直接发送第/ })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /删除第/ })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '编辑第 1 条排队消息' }))
    expect(onEditItem).toHaveBeenCalledExactlyOnceWith({ kind: 'followUp', index: 0, text: originalText, runId: 'image-run' })
    fireEvent.click(screen.getByRole('button', { name: '删除第 2 条排队消息' }))
    expect(onRemoveItem).toHaveBeenCalledExactlyOnceWith('followUp', 1, 'next-run')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '直接发送第 1 条排队消息' })) })
    expect(onSendItem).toHaveBeenCalledExactlyOnceWith('followUp', 0, 'image-run')
    expect(container.querySelector('.task-panel-caption')).toHaveTextContent('等待本轮完成')
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

  it('preserves run identity for send and remove after identical rows shift', async () => {
    const send = vi.fn(), remove = vi.fn()
    const { rerender } = render(<QueuedMessagesCard sessionKey="shifted"
      followUp={['same', 'same']} followUpRunIds={['first-run', 'second-run']}
      onSendItem={send} onRemoveItem={remove} />)
    fireEvent.click(screen.getByRole('button', { name: '删除第 2 条排队消息' }))
    expect(remove).toHaveBeenLastCalledWith('followUp', 1, 'second-run')
    rerender(<QueuedMessagesCard sessionKey="shifted" followUp={['same']}
      followUpRunIds={['second-run']} onSendItem={send} onRemoveItem={remove} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '直接发送第 1 条排队消息' })) })
    expect(send).toHaveBeenCalledExactlyOnceWith('followUp', 0, 'second-run')
    fireEvent.click(screen.getByRole('button', { name: '删除第 1 条排队消息' }))
    expect(remove).toHaveBeenLastCalledWith('followUp', 0, 'second-run')
  })

  it('keeps unidentified and native rows visible with unsupported controls disabled', () => {
    const send = vi.fn(), remove = vi.fn(), edit = vi.fn()
    render(<QueuedMessagesCard sessionKey="unsupported" steering={['native steer']}
      followUp={['native follow-up', 'missing identity']} nativeFollowUpCount={1}
      followUpRunIds={['native-untrusted-id', null]}
      onSendItem={send} onRemoveItem={remove} onEditItem={edit} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    for (const button of screen.getAllByRole('button', { name: /直接发送第|删除第|编辑第/ })) {
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    expect(send).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(edit).not.toHaveBeenCalled()
  })

  it('can collapse the message list and persists the session preference', () => {
    render(
      <QueuedMessagesCard
        sessionKey="session-collapse"
        followUp={['等待当前运行完成']}
        followUpRunIds={['collapse-run']}
      />
    )

    const header = screen.getByRole('button', { name: '收起排队消息' })
    expect(header).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(header)
    expect(screen.getByRole('button', { name: '展开排队消息' })).toHaveAttribute('aria-expanded', 'false')
    expect(window.localStorage.getItem('pion:session-queue-panel-state:session-collapse')).toBe('false')
  })

  it('shows a bounded single-item notice by real run identity after identical rows shift', () => {
    const send = vi.fn(), edit = vi.fn(), remove = vi.fn()
    const errors = [{ runId: 'second', code: 'admission-failed' as const,
      message: '<script>private-token</script>', diagnostic: 'secret'.repeat(10_000) }]
    const props = { sessionKey: 'admission', followUp: ['same', 'same'], followUpRunIds: ['first', 'second'],
      admissionErrors: errors, onSendItem: send, onEditItem: edit, onRemoveItem: remove }
    const { container, rerender } = render(<QueuedMessagesCard {...props} />)
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent(QUEUE_ADMISSION_ERROR_MESSAGES['admission-failed'])
    expect(screen.getAllByRole('listitem')[0]).not.toContainElement(notice)
    expect(screen.getAllByRole('listitem')[1]).toContainElement(notice)
    expect(container.innerHTML).not.toContain('private-token')
    expect(container.innerHTML).not.toContain('secret')
    expect(send).not.toHaveBeenCalled()
    expect(edit).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '直接发送第 2 条排队消息' })).toBeEnabled()
    rerender(<QueuedMessagesCard {...props} followUp={['same']} followUpRunIds={['second']} />)
    expect(screen.getAllByRole('listitem')[0]).toContainElement(screen.getByRole('status'))
    rerender(<QueuedMessagesCard {...props} followUp={['same']} followUpRunIds={['first']} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    rerender(<QueuedMessagesCard {...props} admissionErrors={undefined} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('ignores unknown error codes, native rows and missing identities without changing controls', () => {
    const send = vi.fn()
    const errors = [{ runId: 'native', code: 'admission-failed' }, { runId: 'missing', code: 'admission-failed' },
      { runId: 'local', code: 'private script diagnostic' }] as QueuedMessageAdmissionError[]
    const { container } = render(<QueuedMessagesCard sessionKey="untrusted-errors" followUp={['same', 'same', 'same']}
      nativeFollowUpCount={1} followUpRunIds={['native', null, 'local']} admissionErrors={errors} onSendItem={send} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(container.innerHTML).not.toContain('private script diagnostic')
    expect(screen.getByRole('button', { name: '直接发送第 1 条排队消息' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '直接发送第 2 条排队消息' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '直接发送第 3 条排队消息' })).toBeEnabled()
    expect(send).not.toHaveBeenCalled()
  })

  it('does not mount an empty queue', () => {
    const { container } = render(<QueuedMessagesCard sessionKey="session-empty" />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('0 条')).not.toBeInTheDocument()
    expect(container.querySelector('.task-panel-caption')).not.toBeInTheDocument()
  })
})
