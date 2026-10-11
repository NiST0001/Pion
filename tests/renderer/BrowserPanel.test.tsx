// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from '../../src/renderer/src/features/browser/BrowserPanel'
import { BROWSER_BLANK_URL, BROWSER_PARTITION } from '../../src/shared/browser'

// A DOM-only custom element mock: no Electron guest, network or GUI is started.
function setup() {
  const result = render(<BrowserPanel visible />)
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
