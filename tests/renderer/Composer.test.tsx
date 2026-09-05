// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/renderer/src/features/chat/Composer'

describe('Composer input references and local slash commands', () => {
  afterEach(() => {
    delete (window as unknown as { pion?: unknown }).pion
  })

  it('executes an exact local command with one Enter while the Agent prepares', () => {
    const onSend = vi.fn()
    const onQueue = vi.fn()
    render(
      <Composer
        busy={false}
        disabled={false}
        sendDisabled
        prefill=""
        history={[]}
        commands={[{ name: 'agents', description: 'open agents', source: 'pion' }]}
        contextPressure={0.42}
        contextTokens={42_000}
        contextWindow={100_000}
        localCommandNames={['agents']}
        mode="build"
        onModeChange={vi.fn()}
        onSend={onSend}
        onQueue={onQueue}
        onAbort={vi.fn()}
      />
    )

    expect(screen.getByRole('progressbar', { name: /上下文已使用 42%/ })).toHaveAttribute('aria-valuenow', '42')
    expect(document.querySelector('.send-context-progress')).toHaveStyle('stroke-dashoffset: 58')
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '/agents' } })
    expect(screen.getByRole('button', { name: /Enter 直接发送/ })).toBeEnabled()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('/agents', [])
    expect(onQueue).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  it('keeps Enter as direct send while a run is busy', () => {
    const onSend = vi.fn()
    const onQueue = vi.fn()
    render(
      <Composer
        busy
        disabled={false}
        sendDisabled={false}
        prefill=""
        history={[]}
        commands={[]}
        mode="build"
        onModeChange={vi.fn()}
        onSend={onSend}
        onQueue={onQueue}
        onAbort={vi.fn()}
      />
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '立即插入当前运行' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('立即插入当前运行', [])
    expect(onQueue).not.toHaveBeenCalled()
  })

  it('adds a text reference from the file input after typing @', async () => {
    const onSend = vi.fn()
    render(
      <Composer
        busy={false}
        disabled={false}
        sendDisabled={false}
        prefill=""
        history={[]}
        commands={[]}
        mode="build"
        onModeChange={vi.fn()}
        onSend={onSend}
        onQueue={vi.fn()}
        onAbort={vi.fn()}
      />
    )

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '请查看 @' } })
    expect(screen.getByRole('listbox', { name: '参考文件' })).toBeInTheDocument()

    const fileInput = screen.getByLabelText('选择图像或参考文件')
    const reference = new File(['line one\nline two'], 'notes.md', { type: 'text/markdown' })
    fireEvent.change(fileInput, { target: { files: [reference] } })

    expect(await screen.findByText('@notes.md')).toBeInTheDocument()
    expect(textarea).toHaveValue('请查看 @notes.md ')
    fireEvent.click(screen.getByRole('button', { name: /发送消息/ }))

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      expect.stringContaining('<reference-content>\nline one\nline two\n</reference-content>'),
      []
    ))
  })

  it.each([
    { key: 'Enter', value: '/verify' },
    { key: 'Tab', value: '/verify ' }
  ])('keeps attached images local for $key submission', async ({ key, value }) => {
    const onSend = vi.fn()
    const onQueue = vi.fn()
    Object.defineProperty(window, 'pion', {
      configurable: true,
      value: {
        readClipboardImage: vi.fn().mockResolvedValue({
          type: 'image',
          data: 'aGVsbG8=',
          mimeType: 'image/png'
        })
      }
    })
    render(
      <Composer
        busy={key === 'Tab'}
        disabled={false}
        sendDisabled
        prefill=""
        history={[]}
        commands={[{ name: 'verify', description: 'open verification', source: 'pion' }]}
        localCommandNames={['verify']}
        mode="build"
        onModeChange={vi.fn()}
        onSend={onSend}
        onQueue={onQueue}
        onAbort={vi.fn()}
      />
    )

    const input = screen.getByRole('textbox')
    fireEvent.paste(input, {
      clipboardData: { items: [], getData: () => '' }
    })
    expect(await screen.findByAltText('待发送图像 1')).toBeInTheDocument()
    fireEvent.change(input, { target: { value } })
    fireEvent.keyDown(input, { key })

    expect(onSend).toHaveBeenCalledWith('/verify', [])
    expect(onQueue).not.toHaveBeenCalled()
    expect(screen.getByAltText('待发送图像 1')).toBeInTheDocument()
  })
})
