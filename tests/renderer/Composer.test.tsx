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

  it.each(['@', '请查看@文件', '请查看＠文件', 'name@example.com'])('sends %s with Enter instead of opening the reference picker', (text) => {
    const onSend = vi.fn()
    const { container } = render(
      <Composer
        busy={false} disabled={false} sendDisabled={false}
        prefill="" history={[]} commands={[]} mode="build"
        onModeChange={vi.fn()} onSend={onSend} onQueue={vi.fn()} onAbort={vi.fn()}
      />
    )
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const click = vi.spyOn(picker, 'click').mockImplementation(() => undefined)
    try {
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: text } })
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
      expect(onSend).not.toHaveBeenCalled()
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
      expect(onSend).not.toHaveBeenCalled()
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onSend).toHaveBeenCalledWith(text, [])
      expect(click).not.toHaveBeenCalled()
    } finally {
      click.mockRestore()
    }
  })

  it('triggers the reference menu for CJK-adjacent and full-width @', () => {
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
        onSend={vi.fn()}
        onQueue={vi.fn()}
        onAbort={vi.fn()}
      />
    )
    const textarea = screen.getByRole('textbox')

    // 中文后面不打空格也要触发
    fireEvent.change(textarea, { target: { value: '看一下这个@' } })
    expect(screen.getByRole('listbox', { name: '参考文件' })).toBeInTheDocument()

    // 全角 ＠ 也触发
    fireEvent.change(textarea, { target: { value: '对比一下＠' } })
    expect(screen.getByRole('listbox', { name: '参考文件' })).toBeInTheDocument()

    // 邮箱地址不触发
    fireEvent.change(textarea, { target: { value: 'user@example.com' } })
    expect(screen.queryByRole('listbox', { name: '参考文件' })).not.toBeInTheDocument()
  })

  it('labels images with their order so the model can reference them', async () => {
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
    fireEvent.change(textarea, { target: { value: '对比这两张图' } })

    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (char) => char.charCodeAt(0))
    const fileInput = screen.getByLabelText('选择图像或参考文件')
    fireEvent.change(fileInput, {
      target: { files: [
        new File([bytes], 'first.png', { type: 'image/png' }),
        new File([bytes], 'second.png', { type: 'image/png' })
      ] }
    })

    expect(await screen.findByText('2 张图像待发送')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /发送消息/ }))

    await waitFor(() => {
      const [text, images] = onSend.mock.calls[0]
      expect(images).toHaveLength(2)
      expect(text).toContain('[图像 1: first.png]')
      expect(text).toContain('[图像 2: second.png]')
      expect(text.indexOf('图像 1')).toBeLessThan(text.indexOf('图像 2'))
    })
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
