import { createElement, useEffect, useRef, useState } from 'react'
import { BROWSER_BLANK_URL, BROWSER_PARTITION, isAllowedBrowserUrl, normalizeBrowserUrl } from '../../../../shared/browser'

// Keep the custom element contract local; do not widen every renderer's JSX types.
interface BrowserWebview extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
}

const ACTION_ERROR = '浏览器操作失败，请稍后重试。'
const LOAD_ERROR = '页面无法加载，可能是网络不可用或访问被阻止。请检查地址后重试。'

function isAbortedNavigation(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false
  if ('code' in cause && (cause.code === 'ERR_ABORTED' || cause.code === -3)) return true
  // Electron may reject loadURL with just a formatted Error, without a code.
  return 'message' in cause && typeof cause.message === 'string'
    && /^ERR_ABORTED(?:\s|\(|$)/.test(cause.message)
}

interface BrowserPanelProps {
  visible: boolean
  navigation?: { id: number; url: string }
}

export function BrowserPanel({ visible, navigation }: BrowserPanelProps) {
  const webviewRef = useRef<BrowserWebview | null>(null)
  const readyRef = useRef(false)
  const mountedRef = useRef(false)
  const requestRef = useRef(0)
  const lastNavigationIdRef = useRef<number | null>(null)
  const pendingNavigationRef = useRef<{ id: number; url: string } | null>(null)
  const navigationUrlRef = useRef(BROWSER_BLANK_URL)
  const editingRef = useRef(false)
  const composingRef = useRef(false)
  const [ready, setReady] = useState(false)
  const [draft, setDraft] = useState('')
  const [title, setTitle] = useState('浏览器')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState({ back: false, forward: false })

  const cancelPendingNavigation = () => {
    pendingNavigationRef.current = null
    requestRef.current++
  }
  const performNavigate = (url: string) => {
    const view = webviewRef.current
    if (!view || !readyRef.current || !mountedRef.current) return
    const request = ++requestRef.current
    navigationUrlRef.current = url
    setError('')
    try {
      // Keep src fixed: only explicit requests use the existing guest's API.
      void view.loadURL(url).catch((cause: unknown) => {
        if (!mountedRef.current || request !== requestRef.current) return
        if (isAbortedNavigation(cause)) return
        setLoading(false)
        setError(LOAD_ERROR)
      })
    } catch { setLoading(false); setError(ACTION_ERROR) }
  }
  const consumePendingNavigation = () => {
    const pending = pendingNavigationRef.current
    if (!pending || !readyRef.current) return
    // Consume before calling Electron, including synchronous throws/rejections.
    pendingNavigationRef.current = null
    setDraft(pending.url)
    performNavigate(pending.url)
  }

  useEffect(() => {
    const view = webviewRef.current
    if (!view) return
    mountedRef.current = true
    const sync = () => {
      try {
        const url = normalizeBrowserUrl(view.getURL())
        if (url && !editingRef.current && !composingRef.current) {
          setDraft(url === BROWSER_BLANK_URL ? '' : url)
        }
        const nextTitle = view.getTitle()
        if (typeof nextTitle === 'string') setTitle(nextTitle.trim().slice(0, 256) || '浏览器')
        setHistory({ back: view.canGoBack(), forward: view.canGoForward() })
      } catch { setError(ACTION_ERROR) }
    }
    const onReady = () => {
      readyRef.current = true
      setReady(true)
      sync()
      consumePendingNavigation()
    }
    const onNavigation = (event: Event) => {
      const navigation = event as Event & { isMainFrame?: unknown; url?: unknown }
      if (navigation.isMainFrame !== true) return
      const url = normalizeBrowserUrl(navigation.url)
      if (url) navigationUrlRef.current = url
    }
    const onStart = () => { setLoading(true); setError('') }
    const onStop = () => { setLoading(false); sync() }
    const onFail = (event: Event) => {
      const failure = event as Event & { isMainFrame?: unknown; errorCode?: unknown; validatedURL?: unknown }
      // Ignore subresource failures, malformed payloads and Chromium's expected
      // ERR_ABORTED when a user stops or supersedes a navigation.
      if (failure.isMainFrame !== true || typeof failure.errorCode !== 'number'
        || !Number.isFinite(failure.errorCode) || failure.errorCode === -3) return
      const failedUrl = normalizeBrowserUrl(failure.validatedURL)
      if (!failedUrl || failedUrl !== navigationUrlRef.current) return
      setLoading(false)
      setError(LOAD_ERROR)
    }
    const listeners: [string, EventListener][] = [
      ['dom-ready', onReady], ['did-start-navigation', onNavigation], ['did-navigate', sync], ['did-navigate-in-page', sync],
      ['page-title-updated', sync], ['did-start-loading', onStart],
      ['did-stop-loading', onStop], ['did-fail-load', onFail]
    ]
    for (const [name, listener] of listeners) view.addEventListener(name, listener)
    return () => {
      mountedRef.current = false
      readyRef.current = false
      lastNavigationIdRef.current = null
      cancelPendingNavigation()
      for (const [name, listener] of listeners) view.removeEventListener(name, listener)
    }
  }, [])

  useEffect(() => {
    // Empty props revoke pending work; retain the consumed ID for this mount so
    // removing/reintroducing a request cannot replay an already handled click.
    if (!navigation) { cancelPendingNavigation(); return }
    const { id, url } = navigation
    if (!Number.isSafeInteger(id) || id <= 0) {
      cancelPendingNavigation()
      setError(ACTION_ERROR)
      return
    }
    // Unlike address-bar submission, a clicked link is never normalized/repaired.
    // Validate even a reused ID: malformed props must revoke pending work.
    if (!isAllowedBrowserUrl(url) || url === BROWSER_BLANK_URL) {
      lastNavigationIdRef.current = id
      cancelPendingNavigation()
      setError(ACTION_ERROR)
      return
    }
    if (lastNavigationIdRef.current === id) return
    lastNavigationIdRef.current = id
    cancelPendingNavigation()
    pendingNavigationRef.current = { id, url }
    setDraft(url)
    setError('')
    consumePendingNavigation()
  }, [navigation?.id, navigation?.url])

  const act = (action: (view: BrowserWebview) => void) => {
    cancelPendingNavigation()
    const view = webviewRef.current
    if (!view || !readyRef.current) return
    // History/reload/stop can replace an address-bar request too. A delayed
    // rejection from that older request must not overwrite the newer action.
    try { setError(''); action(view) } catch { setError(ACTION_ERROR) }
  }
  const navigate = () => {
    if (composingRef.current) return
    cancelPendingNavigation()
    const url = normalizeBrowserUrl(draft)
    if (!url) { setError('请输入有效的 HTTP 或 HTTPS 地址。'); return }
    performNavigate(url)
  }

  return <section className="browser-panel" aria-label="浏览器" aria-hidden={!visible}>
    <div className="browser-toolbar">
      <button type="button" aria-label="后退" disabled={!ready || !history.back} onClick={() => act((view) => view.goBack())}>后退</button>
      <button type="button" aria-label="前进" disabled={!ready || !history.forward} onClick={() => act((view) => view.goForward())}>前进</button>
      <button type="button" disabled={!ready} onClick={() => act((view) => {
        if (loading) { view.stop(); setLoading(false) }
        else view.reload()
      })}>{loading ? '停止' : '刷新'}</button>
      <form className="browser-address" onSubmit={(event) => { event.preventDefault(); navigate() }}>
        <input aria-label="网页地址" type="text" inputMode="url" placeholder="输入网址" value={draft}
          autoComplete="off" spellCheck={false}
          onFocus={() => { editingRef.current = true }} onBlur={() => { editingRef.current = false }}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault()
          }} />
        <button type="submit" disabled={!ready}>打开</button>
      </form>
    </div>
    <div className="browser-status"><span className="browser-title" title={title}>{title}</span>
      <span role="status">{loading ? '加载中…' : ready ? '就绪' : '正在准备…'}</span>
    </div>
    {error && <div className="browser-error" role="alert">{error}</div>}
    {createElement('webview', {
      ref: webviewRef, className: 'browser-webview', src: BROWSER_BLANK_URL,
      partition: BROWSER_PARTITION, 'aria-label': '网页内容'
    })}
  </section>
}
