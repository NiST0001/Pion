import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Loader2, RefreshCw, Store, X } from 'lucide-react'

export const PI_PLUGIN_STORE_URL = 'https://pi.dev/packages'

interface PluginWebviewElement extends HTMLElement {
  reload: () => void
}

/** In-app view of the official pi package/plugin catalog. */
export function PluginStoreModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): ReactElement | null {
  const webviewRef = useRef<PluginWebviewElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const webview = webviewRef.current
    if (!webview) return

    const handleStart = (): void => {
      setLoading(true)
      setFailed(false)
    }
    const handleFinish = (): void => {
      setLoading(false)
      setFailed(false)
    }
    const handleFail = (event: Event): void => {
      const details = event as Event & { errorCode?: number }
      if (details.errorCode === -3) return
      setLoading(false)
      setFailed(true)
    }

    webview.addEventListener('did-start-loading', handleStart)
    webview.addEventListener('did-finish-load', handleFinish)
    webview.addEventListener('did-fail-load', handleFail)
    return () => {
      webview.removeEventListener('did-start-loading', handleStart)
      webview.removeEventListener('did-finish-load', handleFinish)
      webview.removeEventListener('did-fail-load', handleFail)
    }
  }, [open])

  if (!open) return null

  return (
    <div className="modal-backdrop plugin-store-backdrop" onClick={onClose}>
      <div
        className="modal plugin-store-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-store-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head plugin-store-head">
          <div className="plugin-store-heading">
            <div className="modal-kicker">PI OFFICIAL CATALOG</div>
            <h2 id="plugin-store-title"><Store size={18} />插件商店</h2>
            <span>官方扩展、技能与工具包</span>
          </div>
          <div className="plugin-store-actions">
            <button
              type="button"
              className="icon-button"
              title="重新加载"
              aria-label="重新加载插件商店"
              onClick={() => webviewRef.current?.reload()}
            >
              <RefreshCw size={15} />
            </button>
            <button type="button" className="icon-button" onClick={onClose} title="关闭">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="plugin-store-body">
          <webview
            ref={webviewRef}
            className="plugin-store-webview"
            src={PI_PLUGIN_STORE_URL}
            partition="persist:pion-plugin-store"
            webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
          />
          {loading && !failed && (
            <div className="plugin-store-state">
              <Loader2 size={18} className="spin" />
              <span>正在加载 pi 官方插件商店…</span>
            </div>
          )}
          {failed && (
            <div className="plugin-store-state plugin-store-error">
              <strong>插件商店暂时无法加载</strong>
              <span>请检查网络连接后重试。</span>
              <button type="button" className="ghost-button" onClick={() => webviewRef.current?.reload()}>
                <RefreshCw size={13} /> 重试
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
