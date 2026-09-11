// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageContent } from '../../src/shared/types'
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

  it('does not show a stale or invented percentage while post-compaction usage is pending', () => {
    render(<Composer busy={false} disabled={false} sendDisabled={false} prefill="" history={[]} commands={[]}
      contextPressure={0.9} contextUsagePending mode="build" onModeChange={vi.fn()}
      onSend={vi.fn()} onQueue={vi.fn()} onAbort={vi.fn()} />)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(document.querySelector('.send-context-progress')).toBeNull()
    expect(screen.getByTitle('上下文已变化，等待下一次模型响应更新用量')).toBeInTheDocument()
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

describe('Composer controlled draft restoration', () => {
  const firstImage: ImageContent = { type: 'image', data: 'Zmlyc3Q=', mimeType: 'image/png' }
  const secondImage: ImageContent = { type: 'image', data: 'c2Vjb25k', mimeType: 'image/jpeg' }

  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as unknown as { pion?: unknown }).pion
  })

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail })
    return { promise, resolve, reject }
  }

  function clipboard(readClipboardImage: () => Promise<ImageContent | null>): void {
    Object.defineProperty(window, 'pion', { configurable: true, value: { readClipboardImage } })
  }

  function setup(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
    const onSend = vi.fn()
    const onQueue = vi.fn()
    const availability = vi.fn()
    const consumed = vi.fn()
    let props: ComponentProps<typeof Composer> = {
      busy: false, disabled: false, sendDisabled: false, prefill: '', history: [], commands: [], mode: 'build',
      onModeChange: vi.fn(), onSend, onQueue, onAbort: vi.fn(),
      onDraftAvailabilityChange: availability, onRestoreDraftConsumed: consumed, ...overrides
    }
    const view = render(<Composer {...props} />)
    return {
      onSend, onQueue, availability, consumed,
      input: screen.getByRole('textbox') as HTMLTextAreaElement,
      picker: screen.getByLabelText('选择图像或参考文件') as HTMLInputElement,
      update(next: Partial<ComponentProps<typeof Composer>>) {
        props = { ...props, ...next }
        view.rerender(<Composer {...props} />)
      }
    }
  }

  it('restores exact text and image blocks while disabled without remounting or consuming an id twice', () => {
    const h = setup({ disabled: true })
    const draft = { id: 'undo-1', text: '  原文第一行\n第二行\t \n', images: [firstImage, secondImage] }
    expect(h.availability).toHaveBeenLastCalledWith(true)
    h.update({ restoreDraft: draft })

    expect(screen.getByRole('textbox')).toBe(h.input)
    expect(h.input).toBeDisabled()
    expect(h.input).toHaveValue(draft.text)
    expect(screen.getByAltText('待发送图像 1')).toHaveAttribute('src', `data:image/png;base64,${firstImage.data}`)
    expect(screen.getByAltText('待发送图像 2')).toHaveAttribute('src', `data:image/jpeg;base64,${secondImage.data}`)
    expect(h.availability).toHaveBeenLastCalledWith(false)
    expect(h.consumed).toHaveBeenCalledExactlyOnceWith(draft.id, true)

    h.update({ disabled: false, restoreDraft: { ...draft, text: '不能重复恢复' } })
    expect(h.input).toHaveValue(draft.text)
    expect(screen.getAllByRole('img')).toHaveLength(2)
    fireEvent.keyDown(h.input, { key: 'Enter' })
    expect(h.onSend).toHaveBeenCalledExactlyOnceWith(draft.text, draft.images)
    expect(h.input).toHaveValue('')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(h.availability).toHaveBeenLastCalledWith(true)

    h.update({ restoreDraft: undefined })
    h.update({ restoreDraft: draft })
    expect(h.input).toHaveValue('')
    expect(h.consumed).toHaveBeenCalledTimes(1)
  })

  it.each(['Enter', 'Tab'])('submits an images-only restored draft with %s and no invented text', (key) => {
    const h = setup({ busy: key === 'Tab' })
    h.update({ restoreDraft: { id: 'images-only', text: '', images: [firstImage, firstImage] } })
    expect(h.input).toHaveValue('')
    expect(screen.getByAltText('待发送图像 1')).toBeInTheDocument()
    expect(screen.getByAltText('待发送图像 2')).toBeInTheDocument()
    if (key === 'Enter') expect(screen.getByRole('button', { name: /发送消息/ })).toBeEnabled()
    fireEvent.keyDown(h.input, { key })
    expect(key === 'Enter' ? h.onSend : h.onQueue).toHaveBeenCalledExactlyOnceWith('', [firstImage, firstImage])
    expect(key === 'Enter' ? h.onQueue : h.onSend).not.toHaveBeenCalled()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(h.availability).toHaveBeenLastCalledWith(true)
  })

  it('removes restored thumbnails without changing verbatim text and invalidates attachment changes synchronously', () => {
    const h = setup()
    const text = '  preserve   spacing\n'
    h.update({ restoreDraft: { id: 'remove-image', text, images: [firstImage] } })
    h.availability.mockClear()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '移除第 1 张图像' }))
      expect(h.availability).toHaveBeenLastCalledWith(false)
    })
    expect(h.input).toHaveValue(text)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    fireEvent.change(h.input, { target: { value: '' } })
    h.update({ restoreDraft: { id: 'remove-only-image', text: '', images: [firstImage] } })
    h.availability.mockClear()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '移除第 1 张图像' }))
      expect(h.availability).toHaveBeenLastCalledWith(false)
    })
    expect(h.availability).toHaveBeenLastCalledWith(true)
  })

  it('labels subsequently added images with their actual position without relabeling restored images', async () => {
    clipboard(vi.fn().mockResolvedValue(secondImage))
    const h = setup()
    h.update({ restoreDraft: { id: 'append-image', text: '', images: [firstImage] } })
    fireEvent.paste(h.input, { clipboardData: { items: [], getData: () => '' } })
    expect(await screen.findByAltText('待发送图像 2')).toBeInTheDocument()
    fireEvent.keyDown(h.input, { key: 'Enter' })
    expect(h.onSend).toHaveBeenCalledExactlyOnceWith('[图像 2: 剪贴板图像]', [firstImage, secondImage])
  })

  it.each(['newer draft', '  \n\t '])('protects existing text %j, including whitespace, and consumes refusals', (text) => {
    const h = setup()
    h.availability.mockClear()
    act(() => {
      fireEvent.change(h.input, { target: { value: text } })
      // Inside the outer act, passive effects have not reported the new draft.
      expect(h.availability).toHaveBeenLastCalledWith(false)
    })
    const draft = { id: 'refused', text: 'older message', images: [firstImage] }
    h.update({ restoreDraft: draft })
    expect(h.input).toHaveValue(text)
    expect(h.consumed).toHaveBeenCalledExactlyOnceWith(draft.id, false)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()

    fireEvent.change(h.input, { target: { value: '' } })
    expect(h.availability).toHaveBeenLastCalledWith(true)
    h.update({ restoreDraft: { ...draft } })
    expect(h.input).toHaveValue('')
    expect(h.consumed).toHaveBeenCalledTimes(1)
    h.update({ restoreDraft: { ...draft, id: 'new-request' } })
    expect(h.input).toHaveValue(draft.text)
    expect(h.consumed).toHaveBeenLastCalledWith('new-request', true)
  })

  it('protects an existing image-only draft', async () => {
    clipboard(vi.fn().mockResolvedValue(firstImage))
    const h = setup()
    fireEvent.paste(h.input, { clipboardData: { items: [], getData: () => '' } })
    expect(await screen.findByAltText('待发送图像 1')).toBeInTheDocument()
    h.update({ restoreDraft: { id: 'old-image', text: 'old text', images: [secondImage] } })
    expect(h.input).toHaveValue('')
    expect(h.consumed).toHaveBeenCalledExactlyOnceWith('old-image', false)
    expect(h.availability).toHaveBeenLastCalledWith(false)
    expect(screen.getByAltText('待发送图像 1')).toHaveAttribute('src', `data:image/png;base64,${firstImage.data}`)
  })

  it('counts native clipboard reads synchronously and never restores over a late image', async () => {
    const pending = deferred<ImageContent | null>()
    const h = setup()
    const read = vi.fn(() => {
      expect(h.availability).toHaveBeenLastCalledWith(false)
      return pending.promise
    })
    clipboard(read)
    act(() => {
      fireEvent.paste(h.input, { clipboardData: { items: [], getData: () => '' } })
      expect(h.availability).toHaveBeenLastCalledWith(false)
    })
    expect(read).toHaveBeenCalledTimes(1)
    h.update({ disabled: true, restoreDraft: { id: 'pending-paste', text: 'older message', images: [secondImage] } })
    expect(h.consumed).toHaveBeenCalledExactlyOnceWith('pending-paste', false)
    await act(async () => { pending.resolve(firstImage) })
    expect(h.input).toHaveValue('')
    expect(screen.getByAltText('待发送图像 1')).toHaveAttribute('src', `data:image/png;base64,${firstImage.data}`)
    expect(h.availability).toHaveBeenLastCalledWith(false)
    expect(h.consumed).toHaveBeenCalledTimes(1)
  })

  it('protects a pending file read and the resulting text attachment', async () => {
    const pending = deferred<string>()
    const h = setup()
    const file = new File([], 'pending.md', { type: 'text/markdown' })
    const read = vi.fn(() => {
      expect(h.availability).toHaveBeenLastCalledWith(false)
      return pending.promise
    })
    Object.defineProperty(file, 'text', { value: read })
    act(() => {
      fireEvent.change(h.picker, { target: { files: [file] } })
      expect(h.availability).toHaveBeenLastCalledWith(false)
      fireEvent.change(h.input, { target: { value: 'do not send while reading' } })
      fireEvent.keyDown(h.input, { key: 'Enter' })
      fireEvent.change(h.input, { target: { value: '' } })
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(h.onSend).not.toHaveBeenCalled()
    h.update({ disabled: true, restoreDraft: { id: 'pending-file', text: 'old text', images: [firstImage] } })
    expect(h.consumed).toHaveBeenCalledExactlyOnceWith('pending-file', false)
    await act(async () => { pending.resolve('new file content') })
    expect(h.input).toHaveValue('')
    expect(screen.getByText('@pending.md')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(h.availability).toHaveBeenLastCalledWith(false)
    h.update({ restoreDraft: { id: 'existing-file', text: 'old text', images: [] } })
    expect(h.consumed).toHaveBeenLastCalledWith('existing-file', false)
  })

  it('counts pasted image FileReader work before it starts', async () => {
    const h = setup()
    const readers: FileReader[] = []
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      expect(h.availability).toHaveBeenLastCalledWith(false)
      readers.push(this)
    })
    const file = new File(['bytes'], 'pasted.png', { type: 'image/png' })
    fireEvent.paste(h.input, {
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => '' }
    })
    expect(readers).toHaveLength(1)
    h.update({ restoreDraft: { id: 'pasted-file', text: 'old text', images: [] } })
    expect(h.consumed).toHaveBeenCalledExactlyOnceWith('pasted-file', false)
    await act(async () => {
      Object.defineProperty(readers[0], 'result', { value: `data:image/png;base64,${firstImage.data}` })
      readers[0].dispatchEvent(new ProgressEvent('load'))
    })
    expect(screen.getByAltText('待发送图像 1')).toHaveAttribute('src', `data:image/png;base64,${firstImage.data}`)
    expect(h.input).toHaveValue('')
    expect(h.availability).toHaveBeenLastCalledWith(false)
  })

  it('stays unavailable until every overlapping paste and file read has settled, using latest callbacks', async () => {
    const first = deferred<ImageContent | null>()
    const second = deferred<ImageContent | null>()
    const fileRead = deferred<string>()
    clipboard(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise))
    const h = setup()
    fireEvent.paste(h.input, { clipboardData: { items: [], getData: () => '' } })
    fireEvent.paste(h.input, { clipboardData: { items: [], getData: () => '' } })
    const file = new File([], 'pending.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'text', { value: () => fileRead.promise })
    fireEvent.change(h.picker, { target: { files: [file] } })
    const availability = vi.fn()
    const consumed = vi.fn()
    h.update({ onDraftAvailabilityChange: availability, onRestoreDraftConsumed: consumed })
    h.availability.mockClear()
    await act(async () => { first.resolve(null) })
    expect(availability).toHaveBeenLastCalledWith(false)
    expect(screen.getByText('正在读取参考…')).toBeInTheDocument()
    await act(async () => { fileRead.reject(new Error('read failed')) })
    expect(availability).toHaveBeenLastCalledWith(false)
    expect(availability).not.toHaveBeenCalledWith(true)
    await act(async () => { second.resolve(null) })
    expect(availability).toHaveBeenLastCalledWith(true)
    expect(screen.queryByText('正在读取参考…')).not.toBeInTheDocument()
    expect(h.availability).not.toHaveBeenCalled()
    h.update({ disabled: true, restoreDraft: { id: 'all-settled', text: 'restore now', images: [] } })
    expect(consumed).toHaveBeenCalledExactlyOnceWith('all-settled', true)
    expect(h.consumed).not.toHaveBeenCalled()
  })

  it('releases availability after a synchronous native clipboard failure', () => {
    clipboard(() => { throw new Error('clipboard unavailable') })
    const h = setup()
    h.availability.mockClear()
    fireEvent.paste(h.input, { clipboardData: { items: [], getData: () => '' } })
    expect(h.availability).toHaveBeenCalledWith(false)
    expect(h.availability).toHaveBeenLastCalledWith(true)
    expect(screen.queryByText('正在读取参考…')).not.toBeInTheDocument()
  })

  it('freezes input, history, paste, drop, picker and attachment removal while disabled without clearing', () => {
    const readClipboardImage = vi.fn().mockResolvedValue(secondImage)
    clipboard(readClipboardImage)
    const h = setup({ disabled: true, history: ['history message'] })
    const text = '  keep this draft\n'
    h.update({ restoreDraft: { id: 'frozen', text, images: [firstImage] } })
    const file = new File([], 'ignored.txt', { type: 'text/plain' })
    const read = vi.fn().mockResolvedValue('ignored')
    Object.defineProperty(file, 'text', { value: read })
    const openPicker = vi.spyOn(h.picker, 'click').mockImplementation(() => undefined)
    h.availability.mockClear()

    fireEvent.change(h.input, { target: { value: '' } })
    h.input.setSelectionRange(0, 0)
    fireEvent.keyDown(h.input, { key: 'ArrowUp' })
    fireEvent.keyDown(h.input, { key: 'Enter' })
    fireEvent.keyDown(h.input, { key: 'Tab' })
    fireEvent.paste(h.input, { clipboardData: { items: [], getData: () => 'ignored' } })
    fireEvent.drop(h.input, { dataTransfer: { files: [file] } })
    fireEvent.change(h.picker, { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: '添加图像或参考文件' }))
    fireEvent.click(screen.getByRole('button', { name: '移除第 1 张图像' }))

    expect(h.input).toHaveValue(text)
    expect(h.picker).toBeDisabled()
    expect(screen.getByAltText('待发送图像 1')).toBeInTheDocument()
    expect(readClipboardImage).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(openPicker).not.toHaveBeenCalled()
    expect(h.onSend).not.toHaveBeenCalled()
    expect(h.onQueue).not.toHaveBeenCalled()
    expect(h.availability).not.toHaveBeenCalled()
    h.update({ disabled: false })
    fireEvent.keyDown(h.input, { key: 'Enter' })
    expect(h.onSend).toHaveBeenCalledExactlyOnceWith(text, [firstImage])
  })

  it('keeps ordinary drafting and attachments editable when only sending is disabled', async () => {
    clipboard(vi.fn().mockResolvedValue(firstImage))
    const h = setup({ sendDisabled: true })
    fireEvent.change(h.input, { target: { value: 'new draft' } })
    fireEvent.paste(h.input, { clipboardData: { items: [], getData: () => '' } })
    expect(await screen.findByAltText('待发送图像 1')).toBeInTheDocument()
    fireEvent.keyDown(h.input, { key: 'Enter' })
    fireEvent.keyDown(h.input, { key: 'Tab' })
    expect(h.input).toHaveValue('new draft')
    expect(h.input).toBeEnabled()
    expect(h.picker).toBeEnabled()
    expect(h.onSend).not.toHaveBeenCalled()
    expect(h.onQueue).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '移除第 1 张图像' }))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('preserves legacy string-prefill replacement behavior', () => {
    const h = setup({ prefill: 'legacy text' })
    expect(h.input).toHaveValue('legacy text')
    fireEvent.change(h.input, { target: { value: 'edited draft' } })
    h.update({ prefill: '  replacement\n' })
    expect(h.input).toHaveValue('  replacement\n')
    h.update({ prefill: '' })
    expect(h.input).toHaveValue('  replacement\n')
  })
})
