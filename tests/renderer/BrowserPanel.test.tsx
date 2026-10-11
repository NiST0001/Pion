// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from '../../src/renderer/src/features/browser/BrowserPanel'
import { BROWSER_BLANK_URL, BROWSER_PARTITION } from '../../src/shared/browser'

// A DOM-only custom element mock: no Electron guest, network or GUI is started.
function setup(navigation?: { id: number; url: string }) {
  const result = render(<BrowserPanel visible navigation={navigation} />)
  const view = result.container.querySelector('webview')!
  const api = {
    loadURL: vi.fn(async (_url: string): Promise<void> => undefined),
    getURL: vi.fn(() => BROWSER_BLANK_URL), getTitle: vi.fn(() => ''),
    canGoBack: vi.fn(() => false), canGoForward: vi.fn(() => false),
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), stop: vi.fn()
  }
  Object.assign(view, api)
  const emit = (name: string, payload: Record<string, unknown> = {}) => {
    act(() => { view.dispatchEvent(Object.assign(new Event(name), payload)) })
  }
  const input = screen.getByRole('textbox', { name: '网页地址' })
  const submit = (url: string) => {
    fireEvent.change(input, { target: { value: url } })
    fireEvent.submit(input.closest('form')!)
  }
  return { ...result, view, api, emit, input, submit }
}
describe('BrowserPanel', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })
  it('starts offline at blank with only the shared partition and secure defaults', () => {
    const { view, api, emit } = setup()
    expect(view).toHaveAttribute('src', BROWSER_BLANK_URL)
    expect(view).toHaveAttribute('partition', BROWSER_PARTITION)
    for (const attribute of ['allowpopups', 'preload', 'webpreferences', 'disablewebsecurity']) {
      expect(view).not.toHaveAttribute(attribute)
    }
    expect(screen.getByRole('button', { name: '打开' })).toBeDisabled()
    emit('dom-ready')
    expect(screen.getByRole('button', { name: '打开' })).toBeEnabled()
    expect(api.loadURL).not.toHaveBeenCalled()
  })

  it('navigates only on explicit submission and keeps the original src across hide/show', () => {
    const { view, api, emit, submit, rerender, container } = setup()
    emit('dom-ready')
    submit('https://example.com/path')
    expect(api.loadURL).toHaveBeenCalledWith('https://example.com/path')
    api.getURL.mockReturnValue('https://example.com/path')
    api.getTitle.mockReturnValue('示例网页')
    emit('did-navigate')
    expect(screen.getByText('示例网页')).toBeInTheDocument()
    rerender(<BrowserPanel visible={false} />)
    expect(container.querySelector('webview')).toBe(view)
    expect(container.querySelector('.browser-panel')).toHaveAttribute('aria-hidden', 'true')
    rerender(<BrowserPanel visible />)
    emit('did-start-loading')
    emit('did-stop-loading')
    expect(container.querySelector('webview')).toBe(view)
    expect(view).toHaveAttribute('src', BROWSER_BLANK_URL)
    expect(api.loadURL).toHaveBeenCalledTimes(1)
  })

  it('waits for dom-ready and consumes only the latest clicked link once', () => {
    const { api, emit, rerender, input } = setup({ id: 1, url: 'https://first.example/' })
    rerender(<BrowserPanel visible navigation={{ id: 2, url: 'https://latest.example/' }} />)
    expect(api.loadURL).not.toHaveBeenCalled()
    emit('dom-ready')
    expect(api.loadURL).toHaveBeenCalledExactlyOnceWith('https://latest.example/')
    expect(input).toHaveValue('https://latest.example/')
    emit('dom-ready')
    expect(api.loadURL).toHaveBeenCalledTimes(1)
  })

  it('preserves the guest and never replays the same request on rerender/hide/reopen', () => {
    const navigation = { id: 1, url: 'https://example.com/raw%2fpath' }
    const { api, emit, rerender, view, container, input } = setup(navigation)
    emit('dom-ready')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'draft' } })
    rerender(<BrowserPanel visible={false} navigation={{ ...navigation }} />)
    rerender(<BrowserPanel visible navigation={{ ...navigation }} />)
    rerender(<BrowserPanel visible navigation={{ id: 1, url: 'https://ignored.example/' }} />)
    rerender(<BrowserPanel visible />)
    rerender(<BrowserPanel visible navigation={navigation} />)
    expect(api.loadURL).toHaveBeenCalledExactlyOnceWith(navigation.url)
    expect(input).toHaveValue('draft')
    expect(container.querySelector('webview')).toBe(view)
    expect(view).toHaveAttribute('src', BROWSER_BLANK_URL)
    // A distinct click on the identical URL really navigates again.
    rerender(<BrowserPanel visible navigation={{ ...navigation, id: 2 }} />)
    expect(api.loadURL).toHaveBeenCalledTimes(2)
    expect(api.loadURL).toHaveBeenLastCalledWith(navigation.url)
    expect(input).toHaveValue(navigation.url)
    expect(container.querySelector('webview')).toBe(view)
  })

  it.each([
    'about:blank', 'example.com', 'localhost:3000', ' https://example.com/',
    'https://example.com/has space', 'https:\\example.com',
    'javascript:alert(1)', 'file:///private', 'data:text/html,private',
    'https://user:secret@example.com/', 'https://@example.com/'
  ])('rejects raw clicked URLs without repairing or external fallback: %s', (url) => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { api, emit, input } = setup({ id: 1, url })
    emit('dom-ready')
    expect(api.loadURL).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器操作失败')
    expect(screen.getByRole('alert')).not.toHaveTextContent(url)
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid click ID %s', (id) => {
    const { api, emit } = setup({ id, url: 'https://example.com/' })
    emit('dom-ready')
    expect(api.loadURL).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器操作失败')
  })

  it('revokes a pending click on empty/invalid requests or manual submission before readiness', () => {
    const { api, emit, rerender } = setup({ id: 1, url: 'https://first.example/' })
    rerender(<BrowserPanel visible />)
    emit('dom-ready')
    expect(api.loadURL).not.toHaveBeenCalled()
    // Even a synthetic submit before readiness cannot leave a stale click queued.
    cleanup()
    const pending = setup({ id: 2, url: 'https://pending.example/' })
    pending.submit('https://manual.example/')
    pending.emit('dom-ready')
    expect(pending.api.loadURL).not.toHaveBeenCalled()
    pending.rerender(<BrowserPanel visible navigation={{ id: 3, url: 'https://accepted.example/' }} />)
    pending.rerender(<BrowserPanel visible navigation={{ id: 4, url: 'about:blank' }} />)
    expect(pending.api.loadURL).toHaveBeenCalledExactlyOnceWith('https://accepted.example/')
    // Address-bar convenience (including blank) is unchanged.
    pending.submit('about:blank')
    expect(pending.api.loadURL).toHaveBeenLastCalledWith(BROWSER_BLANK_URL)
  })

  it('fails closed on malformed replacement even when its ID is reused', () => {
    const { api, emit, rerender } = setup({ id: 1, url: 'https://pending.example/' })
    rerender(<BrowserPanel visible navigation={{ id: 1, url: 'about:blank' }} />)
    emit('dom-ready')
    expect(api.loadURL).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器操作失败')
  })

  it('drops invalid replacements and pending work on unmount before dom-ready', () => {
    const { api, emit, rerender } = setup({ id: 1, url: 'https://pending.example/' })
    rerender(<BrowserPanel visible navigation={{ id: 2, url: 'private.invalid' }} />)
    emit('dom-ready')
    expect(api.loadURL).not.toHaveBeenCalled()
    cleanup()
    const pending = setup({ id: 3, url: 'https://pending.example/' })
    pending.unmount()
    pending.emit('dom-ready')
    expect(pending.api.loadURL).not.toHaveBeenCalled()
  })

  it('does not retry a synchronously failed explicit click', () => {
    const { api, emit, rerender } = setup()
    emit('dom-ready')
    api.loadURL.mockImplementation(() => { throw new Error('private URL') })
    rerender(<BrowserPanel visible navigation={{ id: 1, url: 'https://example.com/' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器操作失败')
    rerender(<BrowserPanel visible navigation={{ id: 1, url: 'https://example.com/' }} />)
    emit('dom-ready')
    expect(api.loadURL).toHaveBeenCalledTimes(1)
  })

  it.each(['empty', 'invalid', 'back', 'forward', 'stop'] as const)('invalidates clicked promise rejection after %s', async (action) => {
    const { api, emit, rerender } = setup()
    api.canGoBack.mockReturnValue(true)
    api.canGoForward.mockReturnValue(true)
    emit('dom-ready')
    let reject!: (cause: Error) => void
    api.loadURL.mockImplementation(() => new Promise<void>((_resolve, rejected) => { reject = rejected }))
    rerender(<BrowserPanel visible navigation={{ id: 1, url: 'https://old.example/' }} />)
    if (action === 'empty') rerender(<BrowserPanel visible />)
    else if (action === 'invalid') rerender(<BrowserPanel visible navigation={{ id: 2, url: 'javascript:private' }} />)
    else {
      if (action === 'stop') emit('did-start-loading')
      fireEvent.click(screen.getByRole('button', { name: action === 'back' ? '后退' : action === 'forward' ? '前进' : '停止' }))
    }
    await act(async () => { reject(new Error('private old failure')) })
    if (action === 'invalid') expect(screen.getByRole('alert')).toHaveTextContent('浏览器操作失败')
    else expect(screen.queryByRole('alert')).toBeNull()
  })

  it('consumes rejected clicks once and protects new clicks/manual actions from late rejection', async () => {
    const { api, emit, rerender, submit, unmount } = setup()
    emit('dom-ready')
    const rejects: Array<(cause: Error) => void> = []
    api.loadURL.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejects.push(reject) }))
    rerender(<BrowserPanel visible navigation={{ id: 1, url: 'https://same.example/' }} />)
    rerender(<BrowserPanel visible navigation={{ id: 2, url: 'https://same.example/' }} />)
    await act(async () => { rejects[0](new Error('private old failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { rejects[1](new Error('private current failure')) })
    expect(screen.getByRole('alert')).toHaveTextContent('页面无法加载')
    expect(screen.getByRole('alert')).not.toHaveTextContent('private')
    rerender(<BrowserPanel visible={false} navigation={{ id: 2, url: 'https://same.example/' }} />)
    rerender(<BrowserPanel visible navigation={{ id: 2, url: 'https://same.example/' }} />)
    emit('dom-ready')
    expect(api.loadURL).toHaveBeenCalledTimes(2)
    rerender(<BrowserPanel visible navigation={{ id: 3, url: 'https://clicked.example/' }} />)
    submit('https://manual.example/')
    await act(async () => { rejects[2](new Error('old clicked failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await act(async () => { rejects[3](new Error('old manual failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(<BrowserPanel visible navigation={{ id: 4, url: 'https://last.example/' }} />)
    unmount()
    await act(async () => { rejects[4](new Error('unmounted failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('tracks history, loading and page title and exposes navigation controls', () => {
    const { api, emit } = setup()
    api.canGoBack.mockReturnValue(true)
    api.canGoForward.mockReturnValue(true)
    emit('dom-ready')
    fireEvent.click(screen.getByRole('button', { name: '后退' }))
    fireEvent.click(screen.getByRole('button', { name: '前进' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(api.goBack).toHaveBeenCalledTimes(1)
    expect(api.goForward).toHaveBeenCalledTimes(1)
    expect(api.reload).toHaveBeenCalledTimes(1)
    emit('did-start-loading')
    expect(screen.getByRole('status')).toHaveTextContent('加载中')
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(api.stop).toHaveBeenCalledTimes(1)
    api.getURL.mockReturnValue('https://example.com/#next')
    emit('did-navigate-in-page')
    expect(screen.getByRole('textbox')).toHaveValue('https://example.com/#next')
    api.getTitle.mockReturnValue('新标题')
    emit('page-title-updated')
    expect(screen.getByText('新标题')).toBeInTheDocument()
    emit('did-stop-loading')
    expect(screen.getByRole('status')).toHaveTextContent('就绪')
  })

  it('does not overwrite a focused address draft when guest navigation arrives', () => {
    const { api, emit, input } = setup()
    emit('dom-ready')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'my unfinished address' } })
    api.getURL.mockReturnValue('https://example.com/new')
    emit('did-navigate')
    expect(input).toHaveValue('my unfinished address')
    fireEvent.blur(input)
    emit('did-navigate-in-page')
    expect(input).toHaveValue('https://example.com/new')
  })

  it('protects IME Enter and ignores form submission during composition', () => {
    const { api, emit, input } = setup()
    emit('dom-ready')
    fireEvent.change(input, { target: { value: 'https://example.com/' } })
    fireEvent.compositionStart(input)
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(false)
    fireEvent.submit(input.closest('form')!)
    expect(api.loadURL).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    fireEvent.submit(input.closest('form')!)
    expect(api.loadURL).toHaveBeenCalledTimes(1)
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false)
  })

  it.each(['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'https://user:secret@example.com/'])('rejects dangerous address %s', (url) => {
    const { api, emit, submit } = setup()
    emit('dom-ready')
    submit(url)
    expect(api.loadURL).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('有效的 HTTP 或 HTTPS')
  })

  it('only reports well-formed main-frame failures without leaking payloads', () => {
    const { emit } = setup()
    emit('dom-ready')
    emit('did-fail-load', { isMainFrame: false, errorCode: -20 })
    emit('did-fail-load', { isMainFrame: true, errorCode: -3 })
    emit('did-fail-load', { isMainFrame: true, errorCode: 'secret diagnostic' })
    expect(screen.queryByRole('alert')).toBeNull()
    emit('did-start-navigation', { isMainFrame: true, url: 'https://secret.invalid/' })
    emit('did-fail-load', { isMainFrame: true, errorCode: -20, errorDescription: 'secret diagnostic', validatedURL: 'https://secret.invalid/' })
    expect(screen.getByRole('alert')).toHaveTextContent('访问被阻止')
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret')
    emit('did-start-loading')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('handles method exceptions and rejected navigation promises with safe messages', async () => {
    const { api, emit, submit } = setup()
    emit('dom-ready')
    api.reload.mockImplementation(() => { throw new Error('private diagnostic') })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器操作失败')
    api.loadURL.mockRejectedValue(new Error('secret url and credentials'))
    submit('https://example.com/')
    await act(async () => undefined)
    expect(screen.getByRole('alert')).toHaveTextContent('页面无法加载')
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret')
  })

  it('does not let an older address rejection or failure replace a newer reload/navigation', async () => {
    const { api, emit, submit } = setup()
    emit('dom-ready')
    let reject!: (cause: Error) => void
    api.loadURL.mockImplementation(() => new Promise<void>((_resolve, rejected) => { reject = rejected }))
    submit('https://old.example/')
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    emit('did-start-navigation', { isMainFrame: true, url: 'https://new.example/' })
    emit('did-start-loading')
    await act(async () => { reject(new Error('old network failure')) })
    emit('did-fail-load', { isMainFrame: true, errorCode: -20, validatedURL: 'https://old.example/' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('加载中')
    emit('did-fail-load', { isMainFrame: true, errorCode: -20, validatedURL: 'https://new.example/' })
    expect(screen.getByRole('alert')).toHaveTextContent('页面无法加载')
  })

  it.each([
    Object.assign(new Error('aborted'), { code: 'ERR_ABORTED' }),
    Object.assign(new Error('aborted'), { code: -3 }),
    new Error('ERR_ABORTED (-3) loading a private URL')
  ])('ignores aborted promises (%s) and cleans all listeners on actual unmount', async (cause) => {
    const { view, api, emit, submit, unmount } = setup()
    emit('dom-ready')
    api.loadURL.mockRejectedValue(cause)
    submit('https://example.com/')
    await act(async () => undefined)
    expect(screen.queryByRole('alert')).toBeNull()
    const remove = vi.spyOn(view, 'removeEventListener')
    unmount()
    expect(remove.mock.calls.map(([name]) => name)).toEqual([
      'dom-ready', 'did-start-navigation', 'did-navigate', 'did-navigate-in-page', 'page-title-updated',
      'did-start-loading', 'did-stop-loading', 'did-fail-load'
    ])
    const calls = api.getURL.mock.calls.length
    emit('did-navigate')
    expect(api.getURL).toHaveBeenCalledTimes(calls)
  })
})
